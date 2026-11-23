import PDFDocument from 'pdfkit';
import { prisma } from '../database/prisma';
import { formatCurrency, formatDate, formatDateShort, formatSom, formatUsd } from '../utils/formatters';
import { toLatinUz } from '../utils/transliterate';
import { SupplierFullHistoryResult, SupplierService } from './supplier.service';

function escapeCsvCell(val: any): string {
  const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  if (str.includes(',') || str.includes('"') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Normalizes Cyrillic / Unicode Uzbek Latin text into crisp ASCII-compatible Uzbek Latin
 * so built-in PDF Helvetica renders cleanly without broken symbols or '?' placeholders.
 */
export function normalizePdfUzbekText(text: string): string {
  return toLatinUz(String(text ?? ''))
    .replace(/[ʻʼ‘’ʹ`´]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[«»“”]/g, '"')
    .replace(/№/g, 'No.')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeSupplierFilename(supplierName: string): string {
  const normalized = normalizePdfUzbekText(supplierName)
    .replace(/['"`]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'Taminotchi').slice(0, 48);
}

function formatTashkentDate(date: Date, sep: '.' | '_' = '.'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Tashkent',
  }).formatToParts(date);
  const dd = parts.find((p) => p.type === 'day')?.value || '01';
  const mm = parts.find((p) => p.type === 'month')?.value || '01';
  const yyyy = parts.find((p) => p.type === 'year')?.value || '2026';
  return `${dd}${sep}${mm}${sep}${yyyy}`;
}

function formatTashkentDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tashkent',
  }).formatToParts(date);
  const dd = parts.find((p) => p.type === 'day')?.value || '01';
  const mm = parts.find((p) => p.type === 'month')?.value || '01';
  const yyyy = parts.find((p) => p.type === 'year')?.value || '2026';
  const hh = parts.find((p) => p.type === 'hour')?.value || '00';
  const min = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

function formatPdfUzsNumber(amount: number, signPrefix = ''): string {
  const rounded = Number(Number(amount || 0).toFixed(2));
  const abs = Math.abs(rounded);
  const hasCents = abs % 1 !== 0;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(abs);
  const effectiveSign = signPrefix || (rounded < 0 ? '-' : '');
  return `${effectiveSign}${formatted}`;
}

function formatPdfUsdNumber(amount: number, signPrefix = ''): string {
  const rounded = Number(Number(amount || 0).toFixed(2));
  const abs = Math.abs(rounded);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  const effectiveSign = signPrefix || (rounded < 0 ? '-' : '');
  return `${effectiveSign}$${formatted}`;
}

function escapePdfText(text: string): string {
  return normalizePdfUzbekText(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildMinimalPdfBuffer(lines: string[]): Buffer {
  const contentLines: string[] = ['BT', '/F1 10 Tf', '40 800 Td', '14 TL'];
  for (const line of lines.slice(0, 52)) {
    contentLines.push(`(${escapePdfText(line)}) Tj T*`);
  }
  contentLines.push('ET');
  const streamContent = contentLines.join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export class ExportService {
  /**
   * MODUL 3: Export strictly isolated by `ownerId` into Excel (UTF-8 BOM .csv) and PDF / HTML-table buffers.
   */
  static async exportOwnerDatabase(ownerId: string) {
    const cleanOwnerId = String(ownerId).trim();

    const [suppliers, invoices, zReports, customerDebts] = await Promise.all([
      prisma.supplier.findMany({
        where: { ownerId: cleanOwnerId, isActive: true },
        orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
      }),
      prisma.invoice.findMany({
        where: { ownerId: cleanOwnerId },
        include: { supplier: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.zReport.findMany({
        where: { ownerId: cleanOwnerId },
        orderBy: { date: 'desc' },
        take: 90,
      }),
      prisma.customerDebt.findMany({
        where: { ownerId: cleanOwnerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const csvRows: string[] = [];
    csvRows.push(`SMARTBAQQOL SHAXSIY BAZA HISOBOTI (Owner ID: ${cleanOwnerId})`);
    csvRows.push(`Eksport vaqti,${escapeCsvCell(formatDate(new Date()))}`);
    csvRows.push('');

    // 1. Suppliers
    csvRows.push("1. TA'MINOTCHILAR RO'YXATI VA QARZLAR");
    csvRows.push("No,Ta'minotchi nomi,Telefon,Qarz (UZS),Qarz (USD)");
    let totalDebtUzs = 0;
    let totalDebtUsd = 0;
    suppliers.forEach((s, idx) => {
      const uzs = Number(s.debtUzs || 0);
      const usd = Number(s.debtUsd || 0);
      totalDebtUzs += uzs;
      totalDebtUsd += usd;
      csvRows.push(
        [
          idx + 1,
          escapeCsvCell(s.name),
          escapeCsvCell(s.phone || '-'),
          uzs.toFixed(2),
          usd.toFixed(2),
        ].join(',')
      );
    });
    csvRows.push(`JAMI,,,${totalDebtUzs.toFixed(2)},${totalDebtUsd.toFixed(2)}`);
    csvRows.push('');

    // 2. Invoices
    csvRows.push('2. OXIRGI NAKLADNOYLAR (NAQD VA NASIYA)');
    csvRows.push("No,Sana,Ta'minotchi,Nakladnoy No,To'lov turi,Asl summa,Skidka,Yakuniy summa,Valyuta");
    invoices.forEach((inv, idx) => {
      const rawAmt = Number(inv.originalAmount ?? inv.totalAmount ?? 0);
      const discAmt = Number(inv.discountAmount ?? 0);
      const finalAmt = Number(inv.totalAmount ?? 0);
      const payLabel = inv.paymentType === 'CASH' ? 'NAQD' : inv.paymentType === 'PARTIAL' ? 'QISMAN' : 'NASIYA';
      csvRows.push(
        [
          idx + 1,
          escapeCsvCell(formatDate(inv.createdAt)),
          escapeCsvCell(inv.supplier?.name || "Noma'lum"),
          escapeCsvCell(inv.invoiceNo || '-'),
          payLabel,
          rawAmt.toFixed(2),
          discAmt.toFixed(2),
          finalAmt.toFixed(2),
          inv.currency,
        ].join(',')
      );
    });
    csvRows.push('');

    // 3. Z-Reports
    csvRows.push('3. KUNLIK Z-OTCHYOTLAR TARIXI (5 USTUNLI)');
    csvRows.push(
      'No,Sana,Terminal (UZS),Click/Karta (UZS),Kassadagi naqd (UZS),Naqd tovar xaridi (UZS),Taminotchilarga berilgan pul (UZS),Jami kunlik savdo (UZS)'
    );
    zReports.forEach((z, idx) => {
      csvRows.push(
        [
          idx + 1,
          escapeCsvCell(formatDateShort(z.date)),
          Number(z.terminalAmount || 0).toFixed(2),
          Number(z.clickAmount || 0).toFixed(2),
          Number(z.cashRemainingInDrawer || 0).toFixed(2),
          Number(z.dailyCashPurchasesUzs || 0).toFixed(2),
          Number(z.dailySupplierPaymentsUzs || 0).toFixed(2),
          Number(z.totalDailySalesUzs || 0).toFixed(2),
        ].join(',')
      );
    });
    csvRows.push('');

    // 4. Customer Debts
    csvRows.push('4. MIJOZLAR NASIYASI');
    csvRows.push('No,Mijoz ismi,Qolgan qarz,Valyuta,Sana');
    customerDebts.forEach((cd, idx) => {
      const rem = Math.max(0, Number(cd.amount || 0) - Number(cd.paidAmount || 0));
      csvRows.push(
        [
          idx + 1,
          escapeCsvCell(cd.customerName),
          rem.toFixed(2),
          cd.currency,
          escapeCsvCell(formatDateShort(cd.createdAt)),
        ].join(',')
      );
    });

    const excelText = '\uFEFF' + csvRows.join('\r\n');
    const excelBuffer = Buffer.from(excelText, 'utf8');
    const dateStamp = new Date().toISOString().slice(0, 10);
    const excelFilename = `SmartBaqqol_Baza_${cleanOwnerId}_${dateStamp}.csv`;

    // Build PDF lines & Printable HTML report
    const pdfLines: string[] = [
      `SMARTBAQQOL - SHAXSIY BAZA HISOBOTI (Owner: ${cleanOwnerId})`,
      `Sana: ${formatDate(new Date())}`,
      `------------------------------------------------------------`,
      `1. TA'MINOTCHILAR QARZI (Jami: ${suppliers.length} ta)`,
      `Jami Qarz (UZS): ${formatSom(totalDebtUzs)} | Jami Qarz (USD): ${formatUsd(totalDebtUsd)}`,
    ];

    for (const s of suppliers.slice(0, 20)) {
      pdfLines.push(
        ` - ${s.name}: UZS ${Number(s.debtUzs).toLocaleString('en-US')} | USD $${Number(s.debtUsd).toFixed(2)}`
      );
    }

    pdfLines.push(`------------------------------------------------------------`);
    pdfLines.push(`2. OXIRGI NAKLADNOYLAR (Jami: ${invoices.length} ta)`);
    for (const inv of invoices.slice(0, 15)) {
      const pType = inv.paymentType === 'CASH' ? 'NAQD' : 'NASIYA';
      pdfLines.push(
        ` - ${formatDateShort(inv.createdAt)} | ${inv.supplier?.name || "Noma'lum"} | ${pType} | ${formatCurrency(inv.totalAmount, inv.currency)}`
      );
    }

    pdfLines.push(`------------------------------------------------------------`);
    pdfLines.push(`3. KUNLIK Z-OTCHYOTLAR (Jami: ${zReports.length} ta)`);
    for (const z of zReports.slice(0, 10)) {
      pdfLines.push(
        ` - ${formatDateShort(z.date)} | Jami savdo: ${formatSom(z.totalDailySalesUzs)}`
      );
    }

    const pdfText = pdfLines.join('\n');
    const pdfBuffer = buildMinimalPdfBuffer(pdfLines);
    const pdfFilename = `SmartBaqqol_Hisobot_${cleanOwnerId}_${dateStamp}.pdf`;

const escapeHtml = (val: any): string =>
  String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const htmlContent = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8" />
<title>SmartBaqqol Shaxsiy Baza Hisoboti</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px; color: #111827; }
  h1, h2 { color: #1e3a8a; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; font-size: 13px; }
  th { background-color: #f3f4f6; font-weight: bold; }
  .summary { background: #eff6ff; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
</style>
</head>
<body>
  <h1>📊 SmartBaqqol — Shaxsiy Baza Hisoboti</h1>
  <div class="summary">
    <p><strong>Foydalanuvchi ID:</strong> ${escapeHtml(cleanOwnerId)}</p>
    <p><strong>Sana:</strong> ${escapeHtml(formatDate(new Date()))}</p>
    <p><strong>Jami Qarz (UZS):</strong> ${escapeHtml(formatSom(totalDebtUzs))} | <strong>Jami Qarz (USD):</strong> ${escapeHtml(formatUsd(totalDebtUsd))}</p>
  </div>
  <h2>1. Ta'minotchilar va Qarzlar (${suppliers.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Ta'minotchi</th><th>Telefon</th><th>Qarz (UZS)</th><th>Qarz (USD)</th></tr></thead>
    <tbody>
      ${suppliers
        .map(
          (s, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.phone || '-')}</td><td>${escapeHtml(formatSom(s.debtUzs))}</td><td>${escapeHtml(formatUsd(s.debtUsd))}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <h2>2. Oxirgi Nakladnoylar (${invoices.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Sana</th><th>Ta'minotchi</th><th>Holati</th><th>Asl summa</th><th>Skidka</th><th>Yakuniy summa</th></tr></thead>
    <tbody>
      ${invoices
        .map(
          (inv, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(formatDate(inv.createdAt))}</td><td>${escapeHtml(inv.supplier?.name || "Noma'lum")}</td><td>${inv.paymentType === 'CASH' ? '💵 Naqd' : '📝 Nasiya'}</td><td>${escapeHtml(formatCurrency(inv.originalAmount ?? inv.totalAmount, inv.currency))}</td><td>${escapeHtml(formatCurrency(inv.discountAmount ?? 0, inv.currency))}</td><td>${escapeHtml(formatCurrency(inv.totalAmount, inv.currency))}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <h2>3. Kunlik Z-Otchyotlar (${zReports.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Sana</th><th>Terminal</th><th>Click</th><th>Kassadagi naqd</th><th>Naqd xarid (avto)</th><th>Ta'minotchiga to'lov (avto)</th><th>Jami Kunlik Savdo</th></tr></thead>
    <tbody>
      ${zReports
        .map(
          (z, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(formatDateShort(z.date))}</td><td>${escapeHtml(formatSom(z.terminalAmount))}</td><td>${escapeHtml(formatSom(z.clickAmount))}</td><td>${escapeHtml(formatSom(z.cashRemainingInDrawer))}</td><td>${escapeHtml(formatSom(z.dailyCashPurchasesUzs))}</td><td>${escapeHtml(formatSom(z.dailySupplierPaymentsUzs))}</td><td><strong>${escapeHtml(formatSom(z.totalDailySalesUzs))}</strong></td></tr>`
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`;

    const htmlBuffer = Buffer.from(htmlContent, 'utf8');
    const htmlFilename = `SmartBaqqol_Jadval_${cleanOwnerId}_${dateStamp}.html`;

    return {
      ownerId: cleanOwnerId,
      excelBuffer,
      excelFilename,
      excelText,
      pdfBuffer,
      pdfFilename,
      pdfText,
      htmlBuffer,
      htmlFilename,
      htmlContent,
      suppliers,
      invoices,
      zReports,
      customerDebts,
    };
  }

  /**
   * Generates a clean, multi-page business Sverka PDF for a supplier's full history (strictly ownerId scoped).
   */
  static async generateSupplierHistoryPdf(
    ownerId: string,
    supplierId: string,
    options?: { now?: Date; compress?: boolean }
  ): Promise<{ buffer: Buffer; filename: string }> {
    const history = await SupplierService.getSupplierFullHistory(ownerId, supplierId);
    const now = options?.now || new Date();
    const filename = `${sanitizeSupplierFilename(history.supplier.name)}_Sverka_${formatTashkentDate(now, '_')}.pdf`;
    const buffer = await renderSupplierHistoryPdfBuffer(history, {
      now,
      compress: options?.compress ?? true,
    });
    return { buffer, filename };
  }
}

export async function renderSupplierHistoryPdfBuffer(
  history: SupplierFullHistoryResult,
  options?: { now?: Date; compress?: boolean }
): Promise<Buffer> {
  const now = options?.now || new Date();
  const compress = options?.compress ?? true;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      bufferPages: true,
      compress,
      info: {
        Title: normalizePdfUzbekText(`${history.supplier.name} - Sverka`),
        Author: 'Dookonchi AI',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const leftX = 36;
    const pageWidth = doc.page.width - 72; // ~523.28 pt
    const bottomLimitY = doc.page.height - 52;

    const cols = [
      { key: 'date', label: 'Sana', width: 72, align: 'left' as const },
      { key: 'action', label: 'Amal', width: 96, align: 'left' as const },
      { key: 'uzs', label: 'Summa (UZS)', width: 102, align: 'right' as const },
      { key: 'usd', label: 'Summa (USD)', width: 82, align: 'right' as const },
      { key: 'note', label: 'Izoh', width: pageWidth - (72 + 96 + 102 + 82), align: 'left' as const },
    ];

    const supplierName = normalizePdfUzbekText(history.supplier.name);
    const supplierPhone = history.supplier.phone ? normalizePdfUzbekText(history.supplier.phone) : null;
    const todayStr = formatTashkentDate(now, '.');
    const firstStr = history.firstDate ? formatTashkentDate(history.firstDate, '.') : todayStr;
    const periodText = history.entries.length > 0 ? `${firstStr} - ${todayStr}` : `Hozircha amaliyotlar yo'q (${todayStr})`;
    const generatedAtStr = formatTashkentDateTime(now);

    // Header Card
    const headerTopY = 36;
    const headerHeight = supplierPhone ? 88 : 74;
    doc
      .save()
      .roundedRect(leftX, headerTopY, pageWidth, headerHeight, 4)
      .fillAndStroke('#EEF2FF', '#1E3A8A')
      .restore();

    doc
      .fillColor('#1E3A8A')
      .font('Helvetica-Bold')
      .fontSize(13)
      .text("TA'MINOTCHI BILAN HISOB-KITOB TARIXI (SVERKA)", leftX + 12, headerTopY + 10, {
        width: pageWidth - 24,
      });

    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10);
    doc.text(`Ta'minotchi: ${supplierName}`, leftX + 12, headerTopY + 30, { width: pageWidth - 24 });

    doc.font('Helvetica').fontSize(9.5);
    let metaY = headerTopY + 45;
    if (supplierPhone) {
      doc.text(`Telefon: ${supplierPhone}`, leftX + 12, metaY, { width: pageWidth - 24 });
      metaY += 14;
    }
    doc.text(`Davr: ${periodText}`, leftX + 12, metaY, { width: (pageWidth - 24) * 0.55 });
    doc.text(`Yaratilgan sana: ${generatedAtStr}`, leftX + 12 + (pageWidth - 24) * 0.55, metaY, {
      width: (pageWidth - 24) * 0.45,
      align: 'right',
    });

    let y = headerTopY + headerHeight + 14;

    const drawTableHeader = (startY: number): number => {
      const rowH = 22;
      doc.save().rect(leftX, startY, pageWidth, rowH).fill('#1E3A8A').restore();
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);

      let cx = leftX;
      for (const col of cols) {
        doc.text(col.label, cx + 5, startY + 6, {
          width: col.width - 10,
          align: col.align,
          lineBreak: false,
        });
        cx += col.width;
      }
      return startY + rowH;
    };

    y = drawTableHeader(y);

    if (history.entries.length === 0) {
      const emptyH = 28;
      doc.save().rect(leftX, y, pageWidth, emptyH).fillAndStroke('#F8FAFC', '#CBD5E1').restore();
      doc
        .fillColor('#64748B')
        .font('Helvetica')
        .fontSize(9.5)
        .text("Hozircha amaliyotlar mavjud emas.", leftX, y + 9, {
          width: pageWidth,
          align: 'center',
        });
      y += emptyH;
    } else {
      history.entries.forEach((entry, idx) => {
        const dateStr = formatTashkentDate(entry.date, '.');
        const actionStr = normalizePdfUzbekText(entry.actionLabel);
        const sign = entry.type === 'INCOMING_GOODS' ? '+' : '-';
        const uzsStr = entry.currency === 'UZS' ? formatPdfUzsNumber(entry.amount, sign) : '-';
        const usdStr = entry.currency === 'USD' ? formatPdfUsdNumber(entry.amount, sign) : '-';
        const noteStr = normalizePdfUzbekText(entry.note || '-') || '-';

        doc.font('Helvetica').fontSize(8.5);
        const noteHeight = doc.heightOfString(noteStr, {
          width: cols[4].width - 10,
        });
        const rowH = Math.max(19, Math.min(54, Math.ceil(noteHeight) + 9));

        if (y + rowH > bottomLimitY) {
          doc.addPage();
          y = 36;
          y = drawTableHeader(y);
        }

        const bg = idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        doc.save().rect(leftX, y, pageWidth, rowH).fill(bg).restore();
        doc
          .save()
          .lineWidth(0.5)
          .strokeColor('#CBD5E1')
          .rect(leftX, y, pageWidth, rowH)
          .stroke()
          .restore();

        // Draw vertical column dividers
        let divX = leftX;
        doc.save().lineWidth(0.4).strokeColor('#E2E8F0');
        for (let i = 0; i < cols.length - 1; i++) {
          divX += cols[i].width;
          doc.moveTo(divX, y).lineTo(divX, y + rowH).stroke();
        }
        doc.restore();

        const actionColor =
          entry.type === 'INCOMING_GOODS'
            ? '#1E40AF'
            : entry.type === 'PAYMENT'
            ? '#15803D'
            : '#B45309';

        let cx = leftX;
        const textY = y + 5;

        doc.fillColor('#111827').font('Helvetica').fontSize(8.5);
        doc.text(dateStr, cx + 5, textY, { width: cols[0].width - 10, align: 'left', lineBreak: false });
        cx += cols[0].width;

        doc.fillColor(actionColor).font('Helvetica-Bold').fontSize(8.5);
        doc.text(actionStr, cx + 5, textY, { width: cols[1].width - 10, align: 'left', lineBreak: false });
        cx += cols[1].width;

        doc.fillColor('#111827').font('Helvetica').fontSize(8.5);
        doc.text(uzsStr, cx + 5, textY, { width: cols[2].width - 10, align: 'right', lineBreak: false });
        cx += cols[2].width;

        doc.text(usdStr, cx + 5, textY, { width: cols[3].width - 10, align: 'right', lineBreak: false });
        cx += cols[3].width;

        doc.fillColor('#334155').font('Helvetica').fontSize(8.3);
        doc.text(noteStr, cx + 5, textY, {
          width: cols[4].width - 10,
          height: rowH - 6,
          ellipsis: true,
        });

        y += rowH;
      });
    }

    // Summary Footer Block
    const summaryBlockH = 128;
    if (y + 16 + summaryBlockH > bottomLimitY) {
      doc.addPage();
      y = 36;
    } else {
      y += 16;
    }

    const { uzs, usd } = history.summary;
    const sumCol1W = pageWidth - 260;
    const sumCol2W = 140;
    const sumCol3W = 120;

    // Summary Title Bar
    doc.save().rect(leftX, y, pageWidth, 22).fill('#1E3A8A').restore();
    doc
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text('YAKUNIY HISOB-KITOB', leftX + 8, y + 6, { width: sumCol1W - 12 });
    doc.text("UZS (so'm)", leftX + sumCol1W, y + 6, { width: sumCol2W - 8, align: 'right' });
    doc.text('USD ($)', leftX + sumCol1W + sumCol2W, y + 6, { width: sumCol3W - 8, align: 'right' });
    y += 22;

    const summaryRows: Array<{ label: string; uzsVal: string; usdVal: string; highlight?: boolean }> = [
      {
        label: 'Jami kelgan yuk',
        uzsVal: `${formatPdfUzsNumber(uzs.totalIncoming)} so'm`,
        usdVal: formatPdfUsdNumber(usd.totalIncoming),
      },
      {
        label: 'Jami berilgan pul',
        uzsVal: `${formatPdfUzsNumber(uzs.totalPayments)} so'm`,
        usdVal: formatPdfUsdNumber(usd.totalPayments),
      },
      {
        label: 'Jami vozvrat',
        uzsVal: `${formatPdfUzsNumber(uzs.totalReturns)} so'm`,
        usdVal: formatPdfUsdNumber(usd.totalReturns),
      },
      {
        label: 'Joriy qoldiq qarz',
        uzsVal: `${formatPdfUzsNumber(uzs.netDebt)} so'm`,
        usdVal: formatPdfUsdNumber(usd.netDebt),
        highlight: true,
      },
    ];

    for (const sRow of summaryRows) {
      const rowH = sRow.highlight ? 26 : 22;
      const fill = sRow.highlight ? '#DBEAFE' : '#F8FAFC';
      const border = sRow.highlight ? '#1E3A8A' : '#CBD5E1';
      doc.save().rect(leftX, y, pageWidth, rowH).fillAndStroke(fill, border).restore();

      doc
        .fillColor(sRow.highlight ? '#1E3A8A' : '#111827')
        .font(sRow.highlight ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(sRow.highlight ? 10 : 9.2);

      const ty = sRow.highlight ? y + 7 : y + 6;
      doc.text(sRow.label, leftX + 8, ty, { width: sumCol1W - 12, lineBreak: false });
      doc.text(sRow.uzsVal, leftX + sumCol1W, ty, { width: sumCol2W - 8, align: 'right', lineBreak: false });
      doc.text(sRow.usdVal, leftX + sumCol1W + sumCol2W, ty, {
        width: sumCol3W - 8,
        align: 'right',
        lineBreak: false,
      });
      y += rowH;
    }

    // Add page footers to all buffered pages without triggering PDFKit auto-pagination
    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const footerY = doc.page.height - 24;
      doc
        .fillColor('#64748B')
        .font('Helvetica')
        .fontSize(8)
        .text(
          `Dookonchi AI  |  ${supplierName}  |  Sahifa ${i + 1} / ${pageRange.count}`,
          leftX,
          footerY,
          { width: pageWidth, align: 'center', lineBreak: false }
        );
      doc.page.margins.bottom = savedBottom;
    }

    doc.end();
  });
}

export const generateSupplierHistoryPdf = ExportService.generateSupplierHistoryPdf.bind(ExportService);


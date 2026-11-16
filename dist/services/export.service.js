"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportService = void 0;
const prisma_1 = require("../database/prisma");
const formatters_1 = require("../utils/formatters");
function escapeCsvCell(val) {
    const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
    if (str.includes(',') || str.includes('"') || str.includes(';')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
function escapePdfText(text) {
    return text
        .replace(/[^\x20-\x7E]/g, '?')
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}
function buildMinimalPdfBuffer(lines) {
    const contentLines = ['BT', '/F1 10 Tf', '40 800 Td', '14 TL'];
    for (const line of lines.slice(0, 52)) {
        contentLines.push(`(${escapePdfText(line)}) Tj T*`);
    }
    contentLines.push('ET');
    const streamContent = contentLines.join('\n');
    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
        `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
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
class ExportService {
    /**
     * MODUL 3: Export strictly isolated by `ownerId` into Excel (UTF-8 BOM .csv) and PDF / HTML-table buffers.
     */
    static async exportOwnerDatabase(ownerId) {
        const cleanOwnerId = String(ownerId).trim();
        const [suppliers, invoices, zReports, customerDebts] = await Promise.all([
            prisma_1.prisma.supplier.findMany({
                where: { ownerId: cleanOwnerId, isActive: true },
                orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
            }),
            prisma_1.prisma.invoice.findMany({
                where: { ownerId: cleanOwnerId },
                include: { supplier: { select: { name: true } } },
                orderBy: { createdAt: 'desc' },
                take: 200,
            }),
            prisma_1.prisma.zReport.findMany({
                where: { ownerId: cleanOwnerId },
                orderBy: { date: 'desc' },
                take: 90,
            }),
            prisma_1.prisma.customerDebt.findMany({
                where: { ownerId: cleanOwnerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
                orderBy: { createdAt: 'desc' },
            }),
        ]);
        const csvRows = [];
        csvRows.push(`SMARTBAQQOL SHAXSIY BAZA HISOBOTI (Owner ID: ${cleanOwnerId})`);
        csvRows.push(`Eksport vaqti,${escapeCsvCell((0, formatters_1.formatDate)(new Date()))}`);
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
            csvRows.push([
                idx + 1,
                escapeCsvCell(s.name),
                escapeCsvCell(s.phone || '-'),
                uzs.toFixed(2),
                usd.toFixed(2),
            ].join(','));
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
            csvRows.push([
                idx + 1,
                escapeCsvCell((0, formatters_1.formatDate)(inv.createdAt)),
                escapeCsvCell(inv.supplier?.name || "Noma'lum"),
                escapeCsvCell(inv.invoiceNo || '-'),
                payLabel,
                rawAmt.toFixed(2),
                discAmt.toFixed(2),
                finalAmt.toFixed(2),
                inv.currency,
            ].join(','));
        });
        csvRows.push('');
        // 3. Z-Reports
        csvRows.push('3. KUNLIK Z-OTCHYOTLAR TARIXI (5 USTUNLI)');
        csvRows.push('No,Sana,Terminal (UZS),Click/Karta (UZS),Kassadagi naqd (UZS),Naqd tovar xaridi (UZS),Taminotchilarga berilgan pul (UZS),Jami kunlik savdo (UZS)');
        zReports.forEach((z, idx) => {
            csvRows.push([
                idx + 1,
                escapeCsvCell((0, formatters_1.formatDateShort)(z.date)),
                Number(z.terminalAmount || 0).toFixed(2),
                Number(z.clickAmount || 0).toFixed(2),
                Number(z.cashRemainingInDrawer || 0).toFixed(2),
                Number(z.dailyCashPurchasesUzs || 0).toFixed(2),
                Number(z.dailySupplierPaymentsUzs || 0).toFixed(2),
                Number(z.totalDailySalesUzs || 0).toFixed(2),
            ].join(','));
        });
        csvRows.push('');
        // 4. Customer Debts
        csvRows.push('4. MIJOZLAR NASIYASI');
        csvRows.push('No,Mijoz ismi,Qolgan qarz,Valyuta,Sana');
        customerDebts.forEach((cd, idx) => {
            const rem = Math.max(0, Number(cd.amount || 0) - Number(cd.paidAmount || 0));
            csvRows.push([
                idx + 1,
                escapeCsvCell(cd.customerName),
                rem.toFixed(2),
                cd.currency,
                escapeCsvCell((0, formatters_1.formatDateShort)(cd.createdAt)),
            ].join(','));
        });
        const excelText = '\uFEFF' + csvRows.join('\r\n');
        const excelBuffer = Buffer.from(excelText, 'utf8');
        const dateStamp = new Date().toISOString().slice(0, 10);
        const excelFilename = `SmartBaqqol_Baza_${cleanOwnerId}_${dateStamp}.csv`;
        // Build PDF lines & Printable HTML report
        const pdfLines = [
            `SMARTBAQQOL - SHAXSIY BAZA HISOBOTI (Owner: ${cleanOwnerId})`,
            `Sana: ${(0, formatters_1.formatDate)(new Date())}`,
            `------------------------------------------------------------`,
            `1. TA'MINOTCHILAR QARZI (Jami: ${suppliers.length} ta)`,
            `Jami Qarz (UZS): ${(0, formatters_1.formatSom)(totalDebtUzs)} | Jami Qarz (USD): ${(0, formatters_1.formatUsd)(totalDebtUsd)}`,
        ];
        for (const s of suppliers.slice(0, 20)) {
            pdfLines.push(` - ${s.name}: UZS ${Number(s.debtUzs).toLocaleString('en-US')} | USD $${Number(s.debtUsd).toFixed(2)}`);
        }
        pdfLines.push(`------------------------------------------------------------`);
        pdfLines.push(`2. OXIRGI NAKLADNOYLAR (Jami: ${invoices.length} ta)`);
        for (const inv of invoices.slice(0, 15)) {
            const pType = inv.paymentType === 'CASH' ? 'NAQD' : 'NASIYA';
            pdfLines.push(` - ${(0, formatters_1.formatDateShort)(inv.createdAt)} | ${inv.supplier?.name || "Noma'lum"} | ${pType} | ${(0, formatters_1.formatCurrency)(inv.totalAmount, inv.currency)}`);
        }
        pdfLines.push(`------------------------------------------------------------`);
        pdfLines.push(`3. KUNLIK Z-OTCHYOTLAR (Jami: ${zReports.length} ta)`);
        for (const z of zReports.slice(0, 10)) {
            pdfLines.push(` - ${(0, formatters_1.formatDateShort)(z.date)} | Jami savdo: ${(0, formatters_1.formatSom)(z.totalDailySalesUzs)}`);
        }
        const pdfText = pdfLines.join('\n');
        const pdfBuffer = buildMinimalPdfBuffer(pdfLines);
        const pdfFilename = `SmartBaqqol_Hisobot_${cleanOwnerId}_${dateStamp}.pdf`;
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
    <p><strong>Foydalanuvchi ID:</strong> ${cleanOwnerId}</p>
    <p><strong>Sana:</strong> ${(0, formatters_1.formatDate)(new Date())}</p>
    <p><strong>Jami Qarz (UZS):</strong> ${(0, formatters_1.formatSom)(totalDebtUzs)} | <strong>Jami Qarz (USD):</strong> ${(0, formatters_1.formatUsd)(totalDebtUsd)}</p>
  </div>
  <h2>1. Ta'minotchilar va Qarzlar (${suppliers.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Ta'minotchi</th><th>Telefon</th><th>Qarz (UZS)</th><th>Qarz (USD)</th></tr></thead>
    <tbody>
      ${suppliers
            .map((s, i) => `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.phone || '-'}</td><td>${(0, formatters_1.formatSom)(s.debtUzs)}</td><td>${(0, formatters_1.formatUsd)(s.debtUsd)}</td></tr>`)
            .join('')}
    </tbody>
  </table>
  <h2>2. Oxirgi Nakladnoylar (${invoices.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Sana</th><th>Ta'minotchi</th><th>Holati</th><th>Asl summa</th><th>Skidka</th><th>Yakuniy summa</th></tr></thead>
    <tbody>
      ${invoices
            .map((inv, i) => `<tr><td>${i + 1}</td><td>${(0, formatters_1.formatDate)(inv.createdAt)}</td><td>${inv.supplier?.name || "Noma'lum"}</td><td>${inv.paymentType === 'CASH' ? '💵 Naqd' : '📝 Nasiya'}</td><td>${(0, formatters_1.formatCurrency)(inv.originalAmount ?? inv.totalAmount, inv.currency)}</td><td>${(0, formatters_1.formatCurrency)(inv.discountAmount ?? 0, inv.currency)}</td><td>${(0, formatters_1.formatCurrency)(inv.totalAmount, inv.currency)}</td></tr>`)
            .join('')}
    </tbody>
  </table>
  <h2>3. Kunlik Z-Otchyotlar (${zReports.length} ta)</h2>
  <table>
    <thead><tr><th>№</th><th>Sana</th><th>Terminal</th><th>Click</th><th>Kassadagi naqd</th><th>Naqd xarid (avto)</th><th>Ta'minotchiga to'lov (avto)</th><th>Jami Kunlik Savdo</th></tr></thead>
    <tbody>
      ${zReports
            .map((z, i) => `<tr><td>${i + 1}</td><td>${(0, formatters_1.formatDateShort)(z.date)}</td><td>${(0, formatters_1.formatSom)(z.terminalAmount)}</td><td>${(0, formatters_1.formatSom)(z.clickAmount)}</td><td>${(0, formatters_1.formatSom)(z.cashRemainingInDrawer)}</td><td>${(0, formatters_1.formatSom)(z.dailyCashPurchasesUzs)}</td><td>${(0, formatters_1.formatSom)(z.dailySupplierPaymentsUzs)}</td><td><strong>${(0, formatters_1.formatSom)(z.totalDailySalesUzs)}</strong></td></tr>`)
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
}
exports.ExportService = ExportService;

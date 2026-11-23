import { Context, SessionFlavor } from 'grammy';
import { Currency, User } from '@prisma/client';
import { SupplierRecordCategory } from '../services/supplier.service';
import { OnboardingUploadTarget } from '../services/onboarding.service';

export interface SupplierEditRecordSession {
  recordType: SupplierRecordCategory;
  recordId: string;
  supplierId: string;
  supplierName: string;
  currency: Currency;
  oldAmount: number;
}

export interface SupplierReturnSession {
  supplierId: string;
  supplierName: string;
  currency: Currency;
}

export interface SessionData {
  step?: string;
  tempData?: any;
  supplierEditRecord?: SupplierEditRecordSession | null;
  supplierReturn?: SupplierReturnSession | null;
  adminUploadTarget?: OnboardingUploadTarget | null;
}
export interface MyContext extends Context, SessionFlavor<SessionData> { user?: User; }

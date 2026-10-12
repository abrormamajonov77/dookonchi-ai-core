import { Context, SessionFlavor } from 'grammy';
import { User } from '@prisma/client';

export interface SessionData {
  step?: string;
  tempData?: any;
}

export interface MyContext extends Context, SessionFlavor<SessionData> {
  user?: User;
}

import { z } from 'zod';

export const email = z.string().trim().email().max(254).refine(v => !/[\r\n\0]/.test(v));
export const draftSchema = z.object({
  recipientName: z.string().max(200).nullable(),
  recipientEmail: email.nullable(),
  subject: z.string().trim().min(1).max(200).refine(v => !/[\r\n\0]/.test(v)),
  body: z.string().trim().min(1).max(10000).refine(v => !v.includes('\0')),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
export type SendState = { status: 'not_sent' | 'submitting' | 'submitted' | 'uncertain'; message: string; receipt?: string };
export type Job = {
  id: string; status: 'queued' | 'transcribing' | 'drafting' | 'ready' | 'error' | 'expired';
  source: 'audio' | 'text'; createdAt: string; version: number;
  transcript?: string; draft?: Draft; error?: string;
  clarification?: string;
  contactProposal?: { name: string; email: string };
  recipientSource?: 'spoken_address' | 'configured_contact' | 'needs_address' | 'edited';
  sender: string | null; send: SendState;
  savedToMailbox: false;
};
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const noSend = (): SendState => ({ status: 'not_sent', message: 'Draft only. Not sent or saved to an email account.' });

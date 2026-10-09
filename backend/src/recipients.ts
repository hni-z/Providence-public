import type { Contact } from './config.js';
import { contactName, nameKey } from './contacts.js';
import { draftSchema, email, type Draft, type Job } from './contracts.js';

const localPart = '[A-Z0-9]+(?:(?:[._+\\-]|\\s+(?:dot|plus|underscore|dash|hyphen)\\s+)[A-Z0-9]+)*';
const domainLabel = '[A-Z0-9]+(?:(?:-|\\s+(?:dash|hyphen)\\s+)[A-Z0-9]+)*';
const domainPart = `${domainLabel}(?:(?:\\.|\\s+dot\\s+)${domainLabel})+`;
const spokenAddress = new RegExp(`^(${localPart})\\s*(?:@|\\s+at\\s+)\\s*(${domainPart})(?=$|[\\s,.;:!?<>])`, 'i');
const literalAddress = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
const command = /^(?:(?:please|can you|could you|would you)\s+)*(?:(?:send|write|draft)(?:\s+(?:an?|the))?\s+(?:new\s+)?(?:email|message)(?:\s+to)?|email(?:\s+to)?|respond\s+to|reply\s+to)\s+/i;
const bodyMarker = /[\s,.;:](?:saying|asking|about|subject|body|message|with\s+(?:a\s+)?(?:subject|body|message))(?=\s|:|$)/i;
export const replyClarification = "I can't access inbox threads. To send a new email, say 'email NAME saying MESSAGE'.";
export type RecipientInput = { command: boolean; hasBody: boolean; replyRequested: boolean; name?: string; address?: string; ambiguous: boolean };

function normalized(part: string) {
  const separators: Record<string, string> = { dot: '.', plus: '+', underscore: '_', dash: '-', hyphen: '-' };
  return part.replace(/\s+(dot|plus|underscore|dash|hyphen)\s+/gi, (_, word: string) => separators[word.toLowerCase()]).toLowerCase();
}

// Only the initial recipient clause is trusted. Never scan the body for a
// command, alias, quoted address, or model-suggested name/address association.
export function parseRecipientInput(text: string): RecipientInput {
  const input = text.trim(), prefix = command.exec(input);
  const remaining = prefix ? input.slice(prefix[0].length) : input;
  const marker = bodyMarker.exec(remaining);
  const clause = (marker ? remaining.slice(0, marker.index) : remaining).trim();
  const threadClause = remaining.split(/[\s,.;:](?:saying|asking|about|with\s+(?:a\s+)?(?:subject|body|message))(?=\s|:|$)/i)[0];
  const result: RecipientInput = {
    command: !!prefix, hasBody: !!marker,
    replyRequested: !!prefix && (/\breply\b/i.test(prefix[0]) || /(?:['’]s\s+(?:(?:last|latest|previous|original)\s+)*(?:email|message)\b|\b(?:thread|inbox)\b|^(?:(?:the|that|this|his|her|their|my|latest|last)\s+)*(?:email|message)\s+from\b)/i.test(threadClause)),
    ambiguous: false,
  };
  if (!clause || /[\r\n\0"“”]/.test(clause)) return { ...result, ambiguous: true };
  // Try only word boundaries. A preceding name must itself be an entire valid
  // name, and the address must consume the rest of the recipient clause.
  for (let start = 0; start < clause.length; start++) {
    if (start && !/[\s<]/.test(clause[start - 1])) continue;
    const tail = clause.slice(start);
    const literal = literalAddress.exec(tail), spoken = spokenAddress.exec(tail);
    const match = literal ?? spoken;
    if (!match) continue;
    const address = literal ? literal[0].toLowerCase() : `${normalized(spoken![1])}@${normalized(spoken![2])}`;
    if (!email.safeParse(address).success) continue;
    const before = clause.slice(0, start).replace(/[\s,<]+$/g, '').replace(/\s+at$/i, '').trim();
    const after = tail.slice(match[0].length).replace(/^[\s>.,;:!?]+/, '');
    if (after || (before && !contactName.safeParse(before).success)) return { ...result, ambiguous: true };
    return { ...result, address, name: before || undefined };
  }
  const name = clause.replace(/[,.;:!?]+$/, '').trim();
  if (!contactName.safeParse(name).success || /\b(?:at|dot|plus|underscore)\b/i.test(name)) return { ...result, ambiguous: true };
  return { ...result, name };
}

export function resolveRecipient(draft: Draft, text: string, contacts: Contact[], allowBareName = false): {
  draft: Draft; recipientSource: Job['recipientSource']; clarification?: string; contactProposal?: Job['contactProposal']; explicitAddress?: string;
} {
  const input = parseRecipientInput(text);
  let address: string | null = null, source: Job['recipientSource'] = 'needs_address';
  let clarification: string | undefined, proposal: Job['contactProposal'];
  const matches = input.name ? contacts.filter(c => nameKey(c.name) === nameKey(input.name!)) : [];
  const known = [...new Set(matches.map(c => c.email.toLowerCase()))];
  const recipientContext = input.command || allowBareName || (!!input.address && !input.name && !input.hasBody);
  if (input.replyRequested) clarification = replyClarification;
  else if (!recipientContext) clarification = 'Please say an email request with one recipient and a message.';
  else if (input.ambiguous || known.length > 1) clarification = 'Which single recipient should I use? Say one full email address.';
  else if (input.address) {
    if (known.length && known[0] !== input.address) clarification = 'That name has a different saved address. Say one full email address to use for this draft.';
    else {
      address = input.address; source = 'spoken_address';
      if (input.name) proposal = { name: input.name, email: address };
    }
  } else if ((input.command || allowBareName) && known.length === 1) {
    address = known[0]; source = 'configured_contact';
  } else clarification = 'What is the recipient’s full email address? You can say their name followed by the address.';
  return {
    draft: draftSchema.parse({ ...draft, recipientName: input.name ?? null, recipientEmail: address }),
    recipientSource: source, clarification, contactProposal: proposal,
    explicitAddress: source === 'spoken_address' ? address! : undefined,
  };
}

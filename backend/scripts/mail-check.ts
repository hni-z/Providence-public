import { configFromEnv, loadEnvironment } from '../src/config.js';
import { AppleMail } from '../src/mail.js';
loadEnvironment();
const config = configFromEnv();
if (!config.sender) throw new Error('Set MAIL_SENDER in backend/.env.local first.');
await new AppleMail().check(config.sender);
console.log('Configured Mail account is available. No email was sent.');

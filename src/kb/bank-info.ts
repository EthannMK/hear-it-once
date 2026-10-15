/**
 * NORTHSTAR BANK INFORMATION (synthetic demo data): branches, hours, products, how-tos.
 * This is what the assistant may state about the bank in general. Anything not here is NOT known,
 * and the assistant must say so plainly rather than invent it. Nothing here is real or binding.
 */
import type { KbArticle } from './kb.ts';

export interface Branch { city: string; area: string; name: string; address: string; hours: string; phone: string; features: string }

export const BRANCHES: Branch[] = [
  { city: 'Yangon', area: 'Kamayut', name: 'Kamayut Branch', address: '48 Pyay Road, Kamayut Township', hours: 'Mon to Fri 9:30 to 16:00, Sat 9:30 to 12:00', phone: '+95 1 555 0101', features: 'cash deposit machine, ATM, foreign exchange' },
  { city: 'Yangon', area: 'Pabedan', name: 'Downtown Branch', address: '112 Bogyoke Aung San Road, Pabedan Township', hours: 'Mon to Fri 9:30 to 16:00', phone: '+95 1 555 0102', features: 'ATM, safe deposit boxes, foreign exchange' },
  { city: 'Yangon', area: 'Bahan', name: 'Inya Branch', address: '7 Inya Road, Bahan Township', hours: 'Mon to Fri 9:30 to 16:00, Sat 9:30 to 12:00', phone: '+95 1 555 0103', features: 'ATM, cash deposit machine' },
  { city: 'Mandalay', area: 'Chanayethazan', name: 'Mandalay Central Branch', address: '26th Street between 78th and 79th, Chanayethazan Township', hours: 'Mon to Fri 9:30 to 16:00', phone: '+95 2 555 0201', features: 'ATM, cash deposit machine, foreign exchange' },
  { city: 'Naypyitaw', area: 'Zabuthiri', name: 'Naypyitaw Branch', address: 'Yazathingaha Road, Zabuthiri Township', hours: 'Mon to Fri 9:30 to 16:00', phone: '+95 67 555 0301', features: 'ATM' },
  { city: 'Manila', area: 'Makati', name: 'Makati Branch', address: '6750 Ayala Avenue, Makati City', hours: 'Mon to Fri 9:00 to 16:00', phone: '+63 2 5555 0401', features: 'ATM, cash deposit machine, remittance desk' },
  { city: 'Manila', area: 'Quezon City', name: 'Quezon City Branch', address: '88 Timog Avenue, Quezon City', hours: 'Mon to Fri 9:00 to 16:00, Sat 9:00 to 12:00', phone: '+63 2 5555 0402', features: 'ATM, remittance desk' },
  { city: 'Cebu', area: 'Cebu City', name: 'Cebu Branch', address: 'Osmena Boulevard, Cebu City', hours: 'Mon to Fri 9:00 to 16:00', phone: '+63 32 555 0501', features: 'ATM, cash deposit machine' },
];

export interface InfoEntry { id: string; topic: string; keywords: string[]; answer: string }

export const INFO: InfoEntry[] = [
  { id: 'INFO-branches', topic: 'Branches and locations', keywords: ['branch', 'branches', 'nearest', 'near me', 'where are you', 'office', 'location', 'visit', 'in person', 'address of'], answer: 'We have branches in Yangon, Mandalay, Naypyitaw, Manila and Cebu. Tell me the city or township and I will give you the nearest one with its hours.' },
  { id: 'INFO-hours', topic: 'Opening hours', keywords: ['opening hours', 'open on', 'what time', 'closing time', 'when do you open', 'when are you open', 'close at', 'saturday', 'sunday', 'weekend', 'holiday'], answer: 'Most branches are open Monday to Friday, 9:30 to 16:00, and some also open Saturday morning. Branches are closed on Sundays and public holidays. This voice line is open every day. Tell me a city and I will give the exact hours.' },
  { id: 'INFO-atm', topic: 'ATMs and cash machines', keywords: ['atm', 'cash machine', 'withdraw', 'withdrawal', 'withdraw cash', 'cash withdrawal', 'withdrawal limit', 'take out cash'], answer: 'Northstar ATMs are at every branch. Cash withdrawals with your debit card are free at our ATMs. The daily limit in this demo is 1,000 US dollars equivalent.' },
  { id: 'INFO-deposit', topic: 'Making a deposit', keywords: ['deposit', 'put money', 'pay in', 'paying in', 'top up my account', 'add money', 'cash in'], answer: 'You can deposit in three ways. Cash at any branch counter or cash deposit machine. A bank transfer from another account into your Northstar account number. Or a cheque at a branch. Cash deposits up to 5,000 US dollars equivalent a day post straight away. I cannot take a deposit over the phone.' },
  { id: 'INFO-atm-deposit', topic: 'Depositing cash at an ATM', keywords: ['atm deposit', 'deposit machine', 'cash deposit machine'], answer: 'At a Northstar ATM or cash deposit machine that takes deposits, put in your debit card and enter your PIN. Choose Deposit, feed in the notes, check the amount on screen and confirm. Cash deposits up to 5,000 US dollars equivalent a day post straight away. Not every machine takes deposits, so the screen will say, and a branch can tell you which ones do.' },
  { id: 'INFO-transfer-fee', topic: 'International transfer fees', keywords: ['international transfer fee', 'international transfer fees', 'transfer fee', 'transfer fees', 'remittance fee', 'remittance fees', 'wire fee', 'wire fees', 'swift fee', 'fee to send money', 'fees to send money'], answer: 'International transfer fees depend on the amount and the country, and the exact fee is shown before you confirm. I do not have a fixed fee table to read out, so I will not guess a figure. The remittance desk or the app will show it up front.' },
  { id: 'INFO-cheque', topic: 'Cheques', keywords: ['cheque', 'check deposit', 'cheque book', 'clear a cheque', 'cheque clearing'], answer: 'Cheques are deposited at a branch and usually clear in two to three working days. You can ask for a cheque book at any branch.' },
  { id: 'INFO-open', topic: 'Opening an account', keywords: ['open an account', 'open account', 'new account', 'become a customer', 'sign up', 'join northstar', 'start an account'], answer: 'To open an account, visit any branch with your NRC or passport and a recent proof of address. A savings account can start with as little as 10 US dollars. It takes about 20 minutes in person.' },
  { id: 'INFO-savings', topic: 'Savings accounts', keywords: ['savings', 'save money', 'saving account', 'savings account'], answer: 'Our Everyday Savings account pays 2.5 percent a year in this demo, calculated daily and paid monthly, with no monthly fee on balances above 100 US dollars.' },
  { id: 'INFO-fixed', topic: 'Fixed deposits', keywords: ['fixed deposit', 'term deposit', 'lock in', 'time deposit'], answer: 'A fixed deposit locks money for 3, 6 or 12 months. In this demo the rates are 3.5, 4.0 and 4.5 percent a year. Breaking it early loses the extra interest.' },
  { id: 'INFO-current', topic: 'Current accounts', keywords: ['current account', 'business account', 'checking account', 'chequing'], answer: 'A current account is for day to day payments and comes with a debit card and a cheque book. There is a small monthly fee, waived above an average balance of 500 US dollars in this demo.' },
  { id: 'INFO-debit', topic: 'Debit and credit cards', keywords: ['debit card', 'credit card', 'apply for a card', 'new card', 'card types', 'platinum', 'card limit', 'card fee', 'apply card'], answer: 'We offer a Visa debit card, a Visa Classic credit card and a Mastercard Platinum credit card. You can apply at a branch or in the mobile app. Approval for credit cards depends on income checks, so I cannot promise an outcome.' },
  { id: 'INFO-loan', topic: 'Loans', keywords: ['loan', 'borrow', 'mortgage', 'personal loan', 'car loan', 'lending', 'home loan'], answer: 'We offer personal loans from 500 to 20,000 US dollars over 6 to 48 months. Loans are decided by a lending officer, so I cannot approve one or quote your exact rate. A branch can start an application with you.' },
  { id: 'INFO-rates', topic: 'Interest rates', keywords: ['interest rate', 'interest', 'apr', 'rate on', 'how much interest', 'rates'], answer: 'In this demo, savings pay 2.5 percent a year, fixed deposits 3.5 to 4.5 percent, and credit cards charge 24 percent a year. These are demo figures and not an offer.' },
  { id: 'INFO-app', topic: 'Mobile app and online banking', keywords: ['mobile app', 'app', 'online banking', 'internet banking', 'download', 'log in', 'login', 'register online'], answer: 'The Northstar app is on the App Store and Google Play. You register with your account number and a passcode sent to your registered phone. In the app you can see balances, transfer money, freeze a card and apply for products.' },
  { id: 'INFO-password', topic: 'Forgotten password', keywords: ['reset my password', 'reset my pin', 'change my password', 'change my pin', 'forgot my password', 'forgot password', 'reset password', 'forgotten password', 'password reset', 'locked out', 'cannot log in', 'forgot my pin', 'reset pin'], answer: 'Passwords and PINs are reset in the app with a passcode sent to your registered phone, or at any branch with your ID. I never ask for or take your PIN or password on this line.' },
  { id: 'INFO-transfer', topic: 'Transfers and remittance', keywords: ['transfer money', 'send money', 'remittance', 'international transfer', 'wire', 'swift', 'overseas', 'abroad send', 'receive money'], answer: 'Local transfers between Northstar accounts are instant and free in the app. International transfers go through the remittance desk at selected branches or in the app, usually in one to three working days. The fee is shown before you confirm.' },
  { id: 'INFO-fx', topic: 'Currency exchange', keywords: ['exchange rate', 'currency', 'foreign exchange', 'change money', 'dollars to', 'kyat', 'peso', 'convert'], answer: 'Foreign exchange is available at selected branches. Rates change during the day, so I cannot quote today\'s rate. The branch shows the live rate before you commit.' },
  { id: 'INFO-fees', topic: 'Fees and charges overview', keywords: ['account fee', 'monthly fee', 'charges list', 'how much do you charge', 'service charge', 'fee schedule'], answer: 'The main fees in this demo are a late payment fee on credit cards, an annual fee on premium cards, a foreign transaction fee, and a cash advance fee. If you have a specific fee on your own card, I can look at it once you are verified.' },
  { id: 'INFO-statement', topic: 'Statements', keywords: ['statement', 'e-statement', 'paper statement', 'bank statement'], answer: 'Statements are issued monthly and available in the app. A paper copy can be requested at a branch for a small fee.' },
  { id: 'INFO-complaint', topic: 'Complaints and feedback', keywords: ['complaint', 'complain', 'feedback', 'unhappy', 'escalate', 'ombudsman'], answer: 'You can complain on this line, at any branch, or in the app. I can log it and pass it to the complaints team with this call attached. They aim to reply within five working days.' },
  { id: 'INFO-contact', topic: 'Contact numbers', keywords: ['phone number', 'contact number', 'call centre', 'hotline', 'email address', 'customer service', 'contact you'], answer: 'The Northstar helpline is plus 95 1 555 0100 in Myanmar and plus 63 2 5555 0400 in the Philippines, every day from 7:00 to 21:00. Lost or stolen cards can be reported on the same numbers at any hour.' },
  { id: 'INFO-security', topic: 'Staying safe from scams', keywords: ['scam', 'phishing', 'fraud tips', 'safe', 'suspicious call', 'suspicious message', 'otp scam', 'secure'], answer: 'Northstar never asks for your PIN, your full card number by message, or a passcode sent to your phone. If someone asks, hang up and call the helpline yourself.' },
  { id: 'INFO-abroad', topic: 'Using your card abroad', keywords: ['travel', 'travelling', 'traveling', 'overseas card', 'use my card abroad', 'foreign trip', 'holiday card'], answer: 'Your card works abroad where Visa or Mastercard is accepted. Turn on travel use in the app before you go, or you may see declines. A foreign transaction fee of 1.5 percent applies.' },
  { id: 'INFO-close', topic: 'Closing an account', keywords: ['close my account', 'close account', 'cancel account', 'cancel my card', 'stop my account'], answer: 'Closing an account is done at a branch with your ID, after any balance is cleared. I cannot close accounts on this line.' },
  { id: 'INFO-docs', topic: 'Documents you may need', keywords: ['documents', 'what do i need to bring', 'proof of address', 'id required', 'kyc'], answer: 'For most branch services bring your NRC or passport. For new accounts or loans, add a recent proof of address, and for loans proof of income.' },
  { id: 'INFO-access', topic: 'Accessibility and languages', keywords: ['languages', 'burmese', 'tagalog', 'english', 'wheelchair', 'accessible', 'hearing', 'sign language', 'speak my language'], answer: 'This line works in English, Burmese and Tagalog, with Lily, Hnin and Maya. Branches have step-free entry, and a branch can arrange help for customers who need it.' },
];

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Best matching entry, or null. Needs a clear keyword hit; weak chatter is not an answer. */
export function searchBankInfo(text: string): InfoEntry | null {
  const t = ` ${norm(text)} `;
  // A deposit made at an ATM is its own question, not a withdrawal question.
  if (/\bdeposit(ing|s)?\b/.test(t) && /\b(atm|cash machine)\b/.test(t) && !/\bwithdraw/.test(t)) return INFO.find((e) => e.id === 'INFO-atm-deposit') ?? null;
  let best: { e: InfoEntry; score: number } | null = null;
  for (const e of INFO) {
    let score = 0;
    for (const k of e.keywords) if (new RegExp(`\\b${norm(k)}(s|es)?\\b`).test(t)) score += norm(k).includes(' ') ? 2 : 1;
    if (score > 0 && (!best || score > best.score)) best = { e, score };
  }
  return best?.e ?? null;
}

/** Branch answer built from structured data when the customer names a place; otherwise asks for one. */
export function branchAnswer(text: string): string | null {
  const t = norm(text);
  const hits = BRANCHES.filter((b) => t.includes(norm(b.area)) || t.includes(norm(b.city)) || t.includes(norm(b.name)));
  if (!hits.length) return null;
  const pick = hits.slice(0, 2);
  return pick.map((b) => `${b.name}, ${b.address}. Open ${b.hours}. Phone ${b.phone}. It has ${b.features}.`).join(' Another is ') + (hits.length > 2 ? ` There are ${hits.length - 2} more nearby if you would like them.` : '');
}

/** One reply for a general bank question, with the entry used. Null when the information is not held. */
export function answerFromInfo(text: string): { entry: InfoEntry; reply: string } | null {
  const e = searchBankInfo(text);
  if (!e) {
    const b = branchAnswer(text);
    return b ? { entry: INFO[0], reply: b } : null;
  }
  if (e.id === 'INFO-branches' || e.id === 'INFO-hours') {
    const b = branchAnswer(text);
    if (b) return { entry: e, reply: b };
  }
  return { entry: e, reply: e.answer };
}

export const INFO_ARTICLES: KbArticle[] = INFO.map((e) => ({
  id: e.id, title: e.topic, categories: ['bank_info'], keywords: e.keywords, excerpt: e.answer, steps: [], ruleRefs: [], version: 'demo-2026.10', synthetic: true as const,
}));

export const NOT_FOUND_AGAIN = "That is not something I have information on either. I can bring in a person, or help with cards, charges, payments, fees and general questions about the bank.";
export const NOT_FOUND = "I don't have that in the information I'm given. I'd rather not guess. I can connect you with an agent, or help with your card, charges, payments and fees.";

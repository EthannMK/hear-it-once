// Interface text (English) and the call languages Lily can speak.
export const LANGS = [['en', 'English'], ['my', 'မြန်မာ'], ['fil', 'Tagalog']];

const D = {
  en: {
    openAgent: 'Open agent workspace ↗', lang: 'Call language', langHint: 'Language Lily speaks and understands',
    panelTitle: 'Test identity and demo data',
    disclaimer: 'Northstar Bank is a fictional bank. Every name, phone number, account reference and card number here is dummy data for testing. Do not enter real card details.',
    pickIdentity: 'Choose a test identity', cardStatus: 'Card {s}', phone: 'Phone (dummy)', account: 'Account reference', standing: 'Standing',
    good: 'In good standing', watch: 'On watch', restricted: 'Restricted', active: 'active',
    panLabel: 'Full demo card number', panHelp: 'Dummy number for testing. Lily will ask for it. Try a wrong one first to see her retry.',
    restrictions: 'Restrictions and alerts', recent: 'Recent transactions', declined: 'Declined payments', none: 'None.',
    lockedNote: 'The identity is fixed during a call. End the call to change it.',
    hintNote: 'You are not role-playing. This is only a test identity so Lily has an account to look up. Ask anything about banking.',
    loading: 'Loading demo data…', noProfiles: 'No demo identities are available.',
    heroTitle: 'Say it once. Lily handles the rest.',
    heroLead: 'Talk to Lily, the AI assistant at Northstar Bank. Ask anything about cards and banking. Choose the call language at the top: English, Burmese or Tagalog.',
    start: 'Start talking to Lily', startNote: 'You are speaking with an AI assistant. Your browser will ask for the microphone. Nothing here touches a real account.',
    tryTitle: 'Things you can ask',
    ex: ["I don't recognise a charge on my card", 'Why was my payment declined?', 'What is this fee?', 'What is APR and how is it calculated?', 'How do I spot a card scam?', 'I want to speak to a person'],
    voiceOk: 'Live voice ready', voiceOff: 'Live voice unavailable — typing works', ai: 'AI assistant · demo',
    connecting: 'Connecting you with Lily', c1: 'Securing the connection', c2: 'Starting your call session', failed: 'We could not connect', retry: 'Try again',
    liveCall: 'Live call with Lily', mute: 'Mute', captions: 'Captions', human: 'Human', end: 'End', talkHuman: 'Talk to a person', endCall: 'End call', muteMic: 'Mute microphone',
    s_speaking: 'Lily is speaking', s_processing: 'Lily is checking…', s_listening: 'Listening', 's_listening-you': 'Hearing you', s_muted: 'Microphone muted', s_reconnecting: 'Reconnecting…', s_ending: 'Ending call…',
    typeHere: 'Or type a message', typeOnly: 'Type to Lily…', send: 'Send', you: 'You', lily: 'Lily', agent: 'Agent', askedPerson: 'You asked for a person.',
    behind: 'Behind the conversation', behindSub: 'Each step Lily takes, including every verification attempt', nothingYet: 'Nothing yet. As Lily looks things up or checks the card number, each step appears here.',
    stages: ['Understand', 'Verify', 'Investigate', 'Explain', 'Confirm', 'Act', 'Record', 'Resolve', 'Handover'],
    hWaiting: 'Waiting for a human agent', hSent: 'Request sent. An agent will pick it up in the Agent CRM.', hJoined: '{n} has joined. Lily has passed on what you discussed.', hConnected: 'Agent connected',
    hNone: 'No agent is free right now. Your request and details are saved for a callback.', hFailed: 'The handover could not be completed.', hDemo: 'The handover happens in this app, not by phone.', hRequested: 'Handover requested', anAgent: 'A support agent',
    bTextOnly: 'Voice is unavailable. Type below — the conversation works the same.', bMic: 'Microphone access was blocked. Type below, or allow the microphone and start again.',
    bLost: 'Connection lost. Your conversation is saved — you can keep typing, or end the call.', micOn: 'Microphone on', micMuted: 'Microphone muted', micDenied: 'Microphone blocked — type instead', typingMode: 'Voice unavailable — typing mode',
    passcode: 'Lily asked for a passcode. Read it out loud:',
    summary: 'Call summary', demoCall: 'Demo call — dummy data', outcome: 'Outcome', told: 'What you told Lily', confirmed: 'Confirmed by bank systems', actions: 'Actions', stillOpen: 'Still open', whatLily: 'What Lily did',
    steps: '{n} recorded steps', again: 'Start another conversation', noChanges: 'No account changes were made. Lily never claims an action happened unless a system confirmed it.', noDetails: 'No details were captured.', nothingConfirmed: 'Nothing was confirmed on this call.', ended: 'Call ended', summaryReady: 'Call ended. Summary ready.',
  },
};

// The screen is English only.
// Every call starts in English with Lily. Tagalog (Maya) joins only when the caller asks. Burmese
// (May) is built but not live yet — see LANGUAGES in src/live/languages.ts.
export const getLang = () => 'en';
/** t('key', { n: 3 }) → English interface text. */
export const t = (k, v = {}) => String(D.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => (v[x] ?? ''));
export const tList = (k) => D.en[k];

// POST /api/register
// validate -> score essay (Claude) -> append to sheet -> email committee + admin
// env vars: see .env.example / README

const { google } = require('googleapis');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@apexmun.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'registrations@apexmun.com';

const COMMITTEE_EMAILS = {
  UNSC: process.env.UNSC_EMAIL || 'unsc@apexmun.com',
  UNHRC: process.env.UNHRC_EMAIL || 'unhrc@apexmun.com',
  DISEC: process.env.DISEC_EMAIL || 'disec@apexmun.com',
};

const EXPERIENCE_LEVELS = new Set([
  'This is my first time (Beginner)',
  '1 Conference',
  '2 to 4 Conferences',
  '5+ Conferences (Expert)',
]);

const COMMITTEE_CODES = new Set(['UNSC', 'UNHRC', 'DISEC']);

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON payload.' });
    }
  }
  body = body || {};

  // bots fill this, real users don't
  if (body.hp_field) {
    return res.status(200).json({ ok: true });
  }

  const { errors, data } = validate(body);
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors[0] });
  }

  let aiScore = null;
  let aiNote = 'AI evaluation unavailable for this submission.';
  try {
    const evaluation = await evaluateEssay(data.essay);
    aiScore = evaluation.score;
    aiNote = evaluation.note;
  } catch (err) {
    console.error('[apex-mun] AI evaluation failed:', err.message);
  }

  const record = { ...data, aiScore, aiNote, submittedAt: new Date().toISOString() };

  try {
    await appendToSheet(record);
  } catch (err) {
    console.error('[apex-mun] Google Sheets write failed:', err.message);
    return res.status(502).json({ ok: false, error: 'Could not save your application. Please try again shortly.' });
  }

  try {
    await sendRoutedEmails(record);
  } catch (err) {
    // email is best-effort, record's already saved
    console.error('[apex-mun] Email routing failed:', err.message);
  }

  return res.status(200).json({ ok: true });
};

function validate(body) {
  const errors = [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  const fullName = str(body.fullName);
  const email = str(body.email);
  const phone = str(body.phone);
  const experience = str(body.experience);
  const essay = str(body.essay);
  const firstChoice = str(body.firstChoice).toUpperCase();
  const secondChoice = str(body.secondChoice).toUpperCase();

  if (!fullName || fullName.length < 2) errors.push('Full name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email address is required.');
  if (!phone || phone.replace(/\D/g, '').length < 7) errors.push('A valid phone number is required.');
  if (!EXPERIENCE_LEVELS.has(experience)) errors.push('Invalid MUN experience level.');

  const wordCount = essay.split(/\s+/).filter(Boolean).length;
  if (wordCount < 30 || wordCount > 200) {
    errors.push('Essay should be roughly 50-100 words.');
  }

  if (!COMMITTEE_CODES.has(firstChoice)) errors.push('Invalid first choice committee.');
  if (!COMMITTEE_CODES.has(secondChoice)) errors.push('Invalid second choice committee.');

  return {
    errors,
    data: { fullName, email, phone, experience, essay, firstChoice, secondChoice },
  };
}

async function evaluateEssay(essay) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system:
        'You are an academic screener for a Model United Nations (MUN) admissions committee. ' +
        'Evaluate the delegate essay strictly on tone, argument strength, and diplomatic reasoning. ' +
        'Respond with ONLY compact JSON, no prose, no markdown fences: ' +
        '{"score": <integer 0-10>, "note": "<one or two sentence academic note>"}',
      messages: [{ role: 'user', content: essay }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API returned ${response.status}`);
  }

  const json = await response.json();
  const text = (json.content && json.content[0] && json.content[0].text) || '{}';
  const parsed = JSON.parse(text);

  const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score) || 0)));
  const note = String(parsed.note || '').slice(0, 500);
  return { score, note };
}

async function appendToSheet(record) {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Applications!A:J',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        record.submittedAt,
        record.fullName,
        record.email,
        record.phone,
        record.experience,
        record.firstChoice,
        record.secondChoice,
        record.essay,
        record.aiScore ?? '',
        record.aiNote ?? '',
      ]],
    },
  });
}

async function sendRoutedEmails(record) {
  const committeeEmail = COMMITTEE_EMAILS[record.firstChoice];
  const recipients = [...new Set([committeeEmail, ADMIN_EMAIL].filter(Boolean))];

  const subject = `New Apex MUN Application — ${record.fullName} (${record.firstChoice})`;
  const html = buildEmailHtml(record);

  await Promise.all(
    recipients.map((to) =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`Resend error for ${to}: ${r.status} ${body}`);
        }
      })
    )
  );
}

function buildEmailHtml(record) {
  const row = (label, value) => `<p style="margin:0 0 8px;"><strong>${label}:</strong> ${escapeHtml(String(value ?? ''))}</p>`;

  return `
    <div style="font-family:Arial,sans-serif;color:#111;">
      <h2 style="color:#8a6d1a;">New Spring Summit Application</h2>
      ${row('Full Name', record.fullName)}
      ${row('Email', record.email)}
      ${row('Phone', record.phone)}
      ${row('MUN Experience', record.experience)}
      ${row('First Choice Committee', record.firstChoice)}
      ${row('Second Choice Committee', record.secondChoice)}
      ${row('AI Essay Score', `${record.aiScore ?? 'N/A'} / 10`)}
      ${row('AI Academic Note', record.aiNote)}
      <hr style="margin:16px 0;border:none;border-top:1px solid #ddd;" />
      <p style="margin:0 0 6px;"><strong>Essay:</strong></p>
      <p style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(record.essay)}</p>
    </div>
  `;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

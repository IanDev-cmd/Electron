const NOTIFY_TO = process.env.NOTIFY_EMAIL_TO || 'iank.njenga@gmail.com';
const recent = new Map();

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function notifyDownload({ ip, userAgent, when, path }) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < 10 * 60 * 1000) return { emailed: false, skipped: 'recent' };
  recent.set(key, now);

  const text = [
    'A setup file was downloaded.',
    'Page: https://electron-y515.onrender.com/setup--download',
    `File: ${path || '/WEOTT-Quote-Builder-Setup.exe'}`,
    `Time: ${when}`,
    `IP: ${ip || 'unknown'}`,
    `Agent: ${userAgent || 'unknown'}`,
  ].join('\n');

  if (!smtpConfigured()) {
    console.log(`Download recorded for ${NOTIFY_TO}. Set SMTP_HOST, SMTP_USER, and SMTP_PASS to send the email.`);
    return { emailed: false, skipped: 'smtp' };
  }

  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === '1' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: NOTIFY_TO,
    subject: 'Nexus setup downloaded',
    text,
  });
  return { emailed: true };
}

module.exports = { notifyDownload, NOTIFY_TO };

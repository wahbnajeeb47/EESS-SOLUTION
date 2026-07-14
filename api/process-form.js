// EESS Solutions — Contact / Quote Form Handler (Vercel Serverless Function)
// Saves submissions to MongoDB Atlas and emails a notification via SMTP.
// Returns JSON: { success: true|false, message: "..." }

const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

// Reuse the DB connection across warm serverless invocations instead of
// reconnecting on every request.
let cachedClient = null;

async function getDb() {
  if (cachedClient) return cachedClient.db();
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client.db();
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed.' });
    return;
  }

  const body = req.body || {};
  const name = clean(body.name);
  const email = clean(body.email);
  const phone = clean(body.phone);
  const message = clean(body.message);
  const type = body.type === 'quote' ? 'quote' : 'contact';

  // ---------- Validate ----------
  const errors = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name || name.length > 150) errors.push('Please provide a valid name.');
  if (!email || !emailRegex.test(email)) errors.push('Please provide a valid email address.');
  if (!message) errors.push('Please include a message.');
  if (phone && !/^[0-9+\-\s()]{6,40}$/.test(phone)) errors.push('Please provide a valid phone number.');

  if (errors.length) {
    res.status(422).json({ success: false, message: errors.join(' ') });
    return;
  }

  // ---------- Save to MongoDB ----------
  try {
    const db = await getDb();
    await db.collection('contact_submissions').insertOne({
      name,
      email,
      phone: phone || null,
      message,
      type,
      ip: req.headers['x-forwarded-for'] || null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('EESS form DB error:', err);
    res.status(500).json({
      success: false,
      message: 'Something went wrong saving your request. Please try again shortly.',
    });
    return;
  }

  // ---------- Send email notification ----------
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'EESS Solutions Website'}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: process.env.ADMIN_EMAIL,
      replyTo: email,
      subject: `${type === 'quote' ? 'New Quote Request' : 'New Contact Message'} — EESS Solutions`,
      text:
        `Name:  ${name}\n` +
        `Email: ${email}\n` +
        `Phone: ${phone || 'Not provided'}\n\n` +
        `Message:\n${message}\n`,
    });
  } catch (err) {
    // The submission is already saved, so a mail failure isn't a hard error
    // for the user — just log it for you to investigate.
    console.error('EESS form: email notification failed:', err);
  }

  res.status(200).json({
    success: true,
    message: 'Thank you — your message has been received. Our team will reach out shortly.',
  });
};

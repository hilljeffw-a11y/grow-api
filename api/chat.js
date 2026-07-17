// api/chat.js
// Grow App — Gemini API proxy
// Deploy to Vercel. Set GEMINI_API_KEY and GROW_CLIENT_SECRET in Vercel environment variables.
// Your app calls https://your-project.vercel.app/api/chat instead of Gemini directly.

// Best-effort in-memory rate limiter. Resets per cold start / per instance,
// so it isn't a hard guarantee across all of Vercel's edge nodes, but it
// stops a single runaway client (bot, leaked URL, buggy retry loop) from
// burning through the Gemini quota during a warm instance's lifetime.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateLimitBuckets = new Map();

function isRateLimited(ip) {
      const now = Date.now();
      const bucket = rateLimitBuckets.get(ip);
      if (!bucket || now > bucket.resetAt) {
              rateLimitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
              return false;
      }
      bucket.count += 1;
      return bucket.count > RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
      // CORS — must be set FIRST, before any method checks, so the browser's
  // OPTIONS preflight (and every other method) always gets these headers.
  // Previously the 405 method check ran before this, so every preflight
  // request got a bare 405 with no CORS headers and browsers blocked all
  // real POST requests from web origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Grow-Secret');

  if (req.method === 'OPTIONS') {
          return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
  }

  // Shared-secret check. The Snack client sends this header on every
  // request. It's readable by anyone who opens the Snack source, so this
  // isn't a strong auth boundary — but it stops generic bots/scrapers that
  // find the bare URL from being able to call the API at all, which is the
  // realistic threat for a hobby endpoint like this.
  const clientSecret = process.env.GROW_CLIENT_SECRET;
      if (clientSecret && req.headers['x-grow-secret'] !== clientSecret) {
              return res.status(401).json({ error: 'Unauthorized' });
      }

  // Per-IP rate limit.
  const ip =
          (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          req.socket?.remoteAddress ||
          'unknown';
      if (isRateLimited(ip)) {
              return res.status(429).json({ error: 'Too many requests, please slow down.' });
      }

  const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
              return res.status(500).json({ error: 'API key not configured' });
      }

  try {
          const { messages, systemPrompt } = req.body;

        if (!messages || !Array.isArray(messages)) {
                  return res.status(400).json({ error: 'messages array required' });
        }

        // Build Gemini request
        const geminiBody = {
                  contents: messages.map(m => ({
                              role: m.role === 'assistant' ? 'model' : 'user',
                              parts: [{ text: m.content }],
                  })),
                  systemInstruction: systemPrompt
                    ? { parts: [{ text: systemPrompt }] }
                              : undefined,
                  generationConfig: {
                              temperature: 0.85,
                              maxOutputTokens: 500,
                              topP: 0.95,
                  },
                  safetySettings: [
                      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                            ],
        };

        // Guard against the Gemini call hanging past Vercel's function timeout.
        // Abort a bit before maxDuration and return a clean JSON error (with the
        // CORS headers already set above) instead of letting the platform kill
        // the function and return a bare 504 with no CORS headers.
        const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 25000);

        let geminiRes;
          try {
                    geminiRes = await fetch(
                                `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
                        {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify(geminiBody),
                                      signal: controller.signal,
                        }
                              );
          } finally {
                    clearTimeout(timeoutId);
          }

        if (!geminiRes.ok) {
                  const err = await geminiRes.text();
                  console.error('Gemini error:', err);
                  return res.status(geminiRes.status).json({ error: 'Gemini API error', details: err });
        }

        const data = await geminiRes.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return res.status(200).json({ text });

  } catch (err) {
          console.error('Server error:', err);
          if (err.name === 'AbortError') {
                    return res.status(504).json({ error: 'Gemini API request timed out' });
          }
          return res.status(500).json({ error: 'Internal server error' });
  }
}

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const morgan = require('morgan');
const helmet = require('helmet');
const validUrl = require('valid-url');
const fs = require('fs');
const path = require('path');
const urlParser = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Load blacklist
let blacklist = [];
try {
  const data = fs.readFileSync('blacklist.txt', 'utf8');
  blacklist = data.split('\n').filter(line => line.trim()).map(line => line.trim());
} catch (err) {
  console.log('No blacklist.txt found, starting empty.');
}

// Usage counter
let counter = { requests: 0 };
try {
  counter = JSON.parse(fs.readFileSync('counter.json', 'utf8'));
} catch (err) {
  fs.writeFileSync('counter.json', JSON.stringify(counter));
}

// Helper to save counter
function saveCounter() {
  fs.writeFileSync('counter.json', JSON.stringify(counter));
}

// Rate limiter for proxy endpoint
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  message: 'Too many requests, please try again later.'
});

// Basic auth for admin
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USERNAME || 'admin']: process.env.ADMIN_PASSWORD || 'admin' },
  challenge: true,
  realm: 'Admin Area'
});

// ==================== ROUTES ====================

// Homepage (served from public/index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin panel
app.get('/admin', adminAuth, (req, res) => {
  res.send(`
    <h1>Admin Panel</h1>
    <p>Total requests: ${counter.requests}</p>
    <h2>Blacklist</h2>
    <ul>${blacklist.map(domain => `<li>${domain}</li>`).join('')}</ul>
    <form method="POST" action="/admin/add-blacklist">
      <input type="text" name="domain" placeholder="example.com" required>
      <button type="submit">Add to blacklist</button>
    </form>
    <form method="POST" action="/admin/remove-blacklist">
      <input type="text" name="domain" placeholder="example.com" required>
      <button type="submit">Remove from blacklist</button>
    </form>
    <form method="POST" action="/admin/reset-counter">
      <button type="submit">Reset counter</button>
    </form>
  `);
});

app.post('/admin/add-blacklist', adminAuth, (req, res) => {
  const domain = req.body.domain.trim();
  if (domain && !blacklist.includes(domain)) {
    blacklist.push(domain);
    fs.writeFileSync('blacklist.txt', blacklist.join('\n'));
  }
  res.redirect('/admin');
});

app.post('/admin/remove-blacklist', adminAuth, (req, res) => {
  const domain = req.body.domain.trim();
  blacklist = blacklist.filter(d => d !== domain);
  fs.writeFileSync('blacklist.txt', blacklist.join('\n'));
  res.redirect('/admin');
});

app.post('/admin/reset-counter', adminAuth, (req, res) => {
  counter.requests = 0;
  saveCounter();
  res.redirect('/admin');
});

// Proxy endpoint
app.get('/proxy', limiter, async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('Missing url parameter');
  }

  // Auto-detect search vs URL
  let finalUrl = target;
  if (!validUrl.isWebUri(target)) {
    // Not a valid URL → treat as search query
    finalUrl = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }

  // Parse host for blacklist check
  try {
    const parsed = new URL(finalUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    if (blacklist.includes(host)) {
      return res.status(403).send('This domain is blacklisted.');
    }
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  counter.requests++;
  saveCounter();

  try {
    const response = await axios.get(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      responseType: 'arraybuffer', // handle binary data
      maxRedirects: 5
    });

    const contentType = response.headers['content-type'] || '';

    // Handle HTML: rewrite links
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // Rewrite all href, src, etc. to go through proxy
      $('[href]').each((i, el) => {
        let href = $(el).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const absolute = new URL(href, finalUrl).href;
            $(el).attr('href', `/proxy?url=${encodeURIComponent(absolute)}`);
          } catch (e) { /* ignore invalid */ }
        }
      });

      $('[src]').each((i, el) => {
        let src = $(el).attr('src');
        if (src) {
          try {
            const absolute = new URL(src, finalUrl).href;
            $(el).attr('src', `/proxy?url=${encodeURIComponent(absolute)}`);
          } catch (e) { /* ignore invalid */ }
        }
      });

      // Also rewrite forms
      $('form[action]').each((i, el) => {
        let action = $(el).attr('action');
        if (action) {
          try {
            const absolute = new URL(action, finalUrl).href;
            $(el).attr('action', `/proxy?url=${encodeURIComponent(absolute)}`);
          } catch (e) { /* ignore */ }
        }
      });

      // Add base tag to help relative URLs? Not always safe, but we'll skip.

      html = $.html();
      res.set('Content-Type', 'text/html');
      res.send(html);
    }
    // Handle CSS: rewrite relative URLs inside (simple version)
    else if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      // Replace url(...) paths with proxy URLs
      css = css.replace(/url\(['"]?([^'"\)]*)['"]?\)/g, (match, p1) => {
        try {
          const absolute = new URL(p1, finalUrl).href;
          return `url('/proxy?url=${encodeURIComponent(absolute)}')`;
        } catch (e) {
          return match; // leave as is if invalid
        }
      });
      res.set('Content-Type', 'text/css');
      res.send(css);
    }
    // All other content (images, JS, etc.) – pass through
    else {
      res.set('Content-Type', contentType);
      res.send(response.data);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`
      <html>
        <head><title>Proxy Error</title></head>
        <body style="background:#1a1a1a; color:#fff; font-family:sans-serif; text-align:center; padding:2rem;">
          <h1>Error loading page</h1>
          <p>${error.message}</p>
          <a href="/" style="color:#bb86fc;">Go back</a>
        </body>
      </html>
    `);
  }
});

// Favicon proxy
app.get('/favicon-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type']);
    res.send(response.data);
  } catch {
    res.status(404).send('Favicon not found');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Resend } = require("resend");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3001;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER || "dunslookupofficial@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM || "DUNS Lookup <noreply@yourdomain.com>";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

// ── Gmail SMTP transporter ────────────────────────────────────────────────────
const gmailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(
  cors({
    origin: FRONTEND_URL === "*" ? true : FRONTEND_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ── Browser singleton ─────────────────────────────────────────────────────────
// Launch once at startup and reuse across requests.
// Each request gets its own context + page (isolated), only the binary process
// is shared — this removes ~20-40s of Chromium startup per request.

let _browser = null;

function getBrowserArgs() {
  const display = process.env.DISPLAY || ":99";
  return {
    headless: false, // headed required — Cloudflare blocks headless
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      `--display=${display}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,720",
    ],
    env: { ...process.env, DISPLAY: display },
  };
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log("[browser] launching Chromium...");
  _browser = await chromium.launch(getBrowserArgs());
  _browser.on("disconnected", () => {
    console.warn("[browser] disconnected — will relaunch on next request");
    _browser = null;
  });
  console.log("[browser] Chromium ready");
  return _browser;
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", browserReady: !!(_browser && _browser.isConnected()), ts: new Date().toISOString() });
});

// ── DUNS Lookup ───────────────────────────────────────────────────────────────

app.post("/api/lookup-duns", async (req, res) => {
  const { companyName, city = "", country = "Frankreich", email } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: "companyName is required" });
  }

  console.log(`[lookup] company="${companyName}" city="${city}" country="${country}" email="${email || "(none)"}"`);

  let context = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });

    // ── Pre-set TrustArc / GDPR consent cookies ───────────────────────────
    await context.addCookies([
      { name: "notice_behavior",                    value: "expressed,eu", domain: ".dnb.com", path: "/" },
      { name: "notice_gdpr_prefs",                  value: "0:1:2",        domain: ".dnb.com", path: "/" },
      { name: "cmapi_cookie_privacy",               value: "permit 1,2,3", domain: ".dnb.com", path: "/" },
      { name: "truste.eu.cookie.notice_gdpr_pr498", value: "1",            domain: ".dnb.com", path: "/" },
    ]);

    const page = await context.newPage();

    // ── Block unnecessary resources ───────────────────────────────────────
    await page.route(
      /\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff|woff2|ttf|eot|otf|mp4|mp3|pdf)(\?.*)?$/i,
      (route) => route.abort()
    );
    // Block third-party JS (analytics, ads, tracking) — keep only dnb.com scripts
    await page.route(/\.js(\?.*)?$/i, (route) => {
      const url = route.request().url();
      return url.includes("dnb.com") ? route.continue() : route.abort();
    });
    await page.route(/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar/i,
      (route) => route.abort()
    );

    // ── Navigate ───────────────────────────────────────────────────────────
    console.log("[lookup] navigating to UPIK...");
    await page.goto("https://www.dnb.com/de-de/upik.html", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    // ── Wait for Cloudflare / page to settle ──────────────────────────────
    console.log("[lookup] waiting for page to load...");
    await page.waitForFunction(
      () => {
        const title = document.title || "";
        const hasForm =
          !!document.querySelector('input[placeholder="Suche hier..."]') ||
          !!document.querySelector("#country");
        return title.includes("UPIK") || hasForm;
      },
      { timeout: 20_000 }
    );
    console.log(`[lookup] page ready — title: "${await page.title()}"`);

    // ── Dismiss cookie banner via DOM removal (faster than click retries) ────
    console.log("[lookup] removing cookie banner via DOM");
    await page.evaluate(() => {
      [
        "#truste-consent-track", "#truste-consent-content", ".truste-banner-overlay",
        "#trustarc-banner-overlay", "#consent_blackbar", "#truste-show-consent",
        ".truste_popframe", "iframe[id*='trustarc']", "iframe[src*='consent.trustarc']",
        "iframe[src*='truste']",
      ].forEach((s) => document.querySelectorAll(s).forEach((el) => el.remove()));
      [
        "notice_behavior=expressed,eu", "notice_gdpr_prefs=0:1:2",
        "cmapi_cookie_privacy=permit 1,2,3", "truste.eu.cookie.notice_gdpr_pr498=1",
      ].forEach((c) => { document.cookie = `${c};path=/;domain=.dnb.com`; });
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    });
    await page.waitForTimeout(100);

    // ── Select country ─────────────────────────────────────────────────────
    console.log(`[lookup] selecting country "${country}"...`);
    const countrySelect = page.locator("#country");
    await countrySelect.waitFor({ state: "visible", timeout: 15_000 });
    await countrySelect.selectOption({ label: country });

    // ── Type company name ──────────────────────────────────────────────────
    console.log("[lookup] typing company name...");
    const searchInput = page.locator('input[placeholder="Suche hier..."]');
    await searchInput.waitFor({ state: "visible", timeout: 10_000 });
    await searchInput.fill(companyName.trim());

    // ── Type city (Stadt) if provided ─────────────────────────────────────
    if (city && city.trim()) {
      console.log(`[lookup] typing city "${city}"...`);
      const cityInput = page.locator(
        'input[placeholder="Stadt"], input[name*="tadt"], input[name*="city"], input[id*="tadt"], input[id*="city"]'
      ).first();
      const cityVisible = await cityInput.isVisible({ timeout: 3_000 }).catch(() => false);
      if (cityVisible) {
        await cityInput.fill(city.trim());
      } else {
        console.log("[lookup] city field not found — skipping");
      }
    }

    // ── Click submit ──────────────────────────────────────────────────────
    console.log("[lookup] clicking submit...");
    const submitBtn = page.locator('button[type="submit"]').filter({
      hasNot: page.locator(':text("Suche löschen")'),
    });
    await submitBtn.first().click();

    // ── Wait for results ───────────────────────────────────────────────────
    console.log("[lookup] waiting for results...");
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes("Suchergebnisse") || text.includes("Keine Ergebnisse") || /D-U-N-S[^:]*:\s*\d/i.test(text);
      },
      { timeout: 30_000 }
    ).catch(() => console.log("[lookup] result wait timed out — extracting anyway"));

    // ── Diagnostic: log the results area text ─────────────────────────────
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log("[lookup] page text (first 2000 chars):\n" + pageText.slice(0, 2000));

    // ── Extract results ────────────────────────────────────────────────────
    // UPIK result structure (observed):
    //   <a>COMPANY NAME</a>          ← name as link
    //   D-U-N-S® Nummer: 776849358  ← DUNS line
    //   Unternehmensadresse:         ← address label
    //   38 RUE D'ITALIE, 62570 ...  ← address value
    //
    // The page also contains marketing text with "D-U-N-S" mentions (e.g.
    // "Was ist die D&B D-U-N-S® Nummer?") which must be excluded.
    // Fix: scope the extraction to the DOM subtree that appears after the
    // "Suchergebnisse" heading, then post-filter obvious nav noise.
    console.log("[lookup] extracting results...");
    const results = await page.evaluate(() => {
      // Keywords that identify navigation / marketing text — not real results
      const NAV_NOISE =
        /UPIK|Plattform|D&B|Was ist|Suche\s*(l.schen|hier)|Datenschutz|Impressum|Cookie|Hinweis|Suchergebnis/i;

      // ── Find the "Suchergebnisse" results container ───────────────────────
      // Walk text nodes to find the heading, then use its ancestor as root
      // so the main extraction never touches nav / marketing sections.
      let searchRoot = document.body;
      {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (/^Suchergebnisse/i.test(n.textContent.trim())) {
            // Walk up a few levels to get a meaningful container
            let el = n.parentElement;
            for (let i = 0; i < 4 && el && el.parentElement; i++) el = el.parentElement;
            searchRoot = el || document.body;
            break;
          }
        }
      }

      const extracted = [];

      // ── Strategy 1: DOM traversal scoped to results section ──────────────
      const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
      const visited = new Set();
      let node;

      while ((node = walker.nextNode())) {
        // Only care about "D-U-N-S® Nummer:" lines (has the colon + digits)
        if (!/D-U-N-S[^:]*:\s*[\d]/i.test(node.textContent)) continue;

        // Climb to a tight container that holds the full result card
        let container = node.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          const t = container.innerText || "";
          if (/D-U-N-S[^:]*:\s*[\d]/i.test(t) &&
              (container.querySelector("a") || /Unternehmensadresse/i.test(t))) {
            break;
          }
          container = container.parentElement;
        }
        if (!container || visited.has(container)) continue;
        visited.add(container);

        const text = container.innerText || "";

        // Extract DUNS number
        const dunsMatch = text.match(/D-U-N-S[^:]*:\s*([\d][\d\s\-]{6,10}[\d])/i);
        if (!dunsMatch) continue;
        const duns = dunsMatch[1].replace(/[\s\-]/g, "");
        if (duns.length !== 9) continue;

        // Extract name: first <a> link, or line before the DUNS line
        const link = container.querySelector("a");
        let name = link ? link.innerText.trim() : "";
        if (!name) {
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const idx = lines.findIndex((l) => /D-U-N-S[^:]*:\s*[\d]/i.test(l));
          name = idx > 0 ? lines[idx - 1] : lines[0] || "";
        }

        // Extract address: text after "Unternehmensadresse:"
        const addrMatch = text.match(/Unternehmensadresse[:\s]+([^\n]+)/i);
        let address = addrMatch ? addrMatch[1].trim() : "";
        if (!address) {
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const idx = lines.findIndex((l) => /D-U-N-S[^:]*:\s*[\d]/i.test(l));
          if (idx >= 0 && idx + 1 < lines.length) {
            const candidate = lines[idx + 1];
            address = /Unternehmensadresse/i.test(candidate)
              ? (lines[idx + 2] || "")
              : candidate;
          }
        }

        extracted.push({ name, duns, address });
      }

      // ── Strategy 2: line-by-line fallback scoped to after "Suchergebnisse"
      if (extracted.length === 0) {
        const allLines = (document.body.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        const startIdx = allLines.findIndex((l) => /^Suchergebnisse/i.test(l));
        const lines = startIdx >= 0 ? allLines.slice(startIdx) : allLines;

        for (let i = 0; i < lines.length; i++) {
          const dunsMatch = lines[i].match(/D-U-N-S[^:]*:\s*([\d][\d\s\-]{6,10}[\d])/i);
          if (!dunsMatch) continue;
          const duns = dunsMatch[1].replace(/[\s\-]/g, "");
          if (duns.length !== 9) continue;

          const name = i > 0 ? lines[i - 1] : "";
          let address = "";
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (/Unternehmensadresse/i.test(lines[j])) {
              const inline = lines[j].replace(/Unternehmensadresse[:\s]*/i, "").trim();
              address = inline || (lines[j + 1] || "");
              break;
            }
          }
          extracted.push({ name, duns, address });
        }
      }

      // ── Post-filter: discard nav/marketing noise ──────────────────────────
      return extracted.filter((r) => !NAV_NOISE.test(r.name) && r.name.length < 100);
    });

    console.log(`[lookup] found ${results.length} result(s):`, JSON.stringify(results));

    // ── Close page immediately after extraction ────────────────────────────
    await page.close().catch(() => {});

    // ── Send email (Resend if key set, else Gmail SMTP) ───────────────────
    if (results.length > 0 && email && email.trim()) {
      try {
        const best = results.find((r) => r.name && r.duns) || results[0];
        const htmlEmail = buildEmailHtml(best, companyName, country);

        if (RESEND_API_KEY) {
          // ── Resend (domain-based) ───────────────────────────────────────
          const resend = new Resend(RESEND_API_KEY);
          await resend.emails.send({
            from: EMAIL_FROM,
            to: email.trim(),
            subject: `Votre numéro D-U-N-S — ${escapeHtml(best.name || companyName)}`,
            html: htmlEmail,
          });
          console.log(`[email] sent to ${email.trim()} via Resend`);
        } else if (GMAIL_APP_PASSWORD) {
          // ── Gmail SMTP (fallback) ───────────────────────────────────────
          await gmailTransporter.sendMail({
            from: `"DUNS Lookup" <${GMAIL_USER}>`,
            to: email.trim(),
            subject: `Votre numéro D-U-N-S — ${escapeHtml(best.name || companyName)}`,
            html: htmlEmail,
          });
          console.log(`[email] sent to ${email.trim()} via Gmail`);
        } else {
          console.warn("[email] no email provider configured (RESEND_API_KEY or GMAIL_APP_PASSWORD missing) — skipping");
        }
      } catch (mailErr) {
        console.error("[email] send failed:", mailErr.message);
      }
    }

    // Keep only the best result: first entry that has name + duns + address.
    // Fall back to first entry with just a duns if nothing complete is found.
    const best =
      results.find((r) => r.name && r.duns && r.address) ||
      results.find((r) => r.duns) ||
      null;

    const data = best
      ? { companyName: best.name || companyName, dunsNumber: best.duns, address: best.address || "" }
      : null;

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[lookup] error:", err.message);
    return res.status(500).json({ error: "Lookup failed", details: err.message });
  } finally {
    // Close context (isolated session) but keep the browser process alive
    if (context) await context.close().catch(() => {});
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEmailHtml(result, companyName, country) {
  const name = escapeHtml(result.name || companyName);
  const duns = escapeHtml(result.duns || "—");
  const address = escapeHtml(result.address || "");
  const date = new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Votre numéro D-U-N-S</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(99,102,241,0.10);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);padding:36px 40px;text-align:center;">
              <div style="font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">DUNS Lookup</div>
              <div style="font-size:13px;color:#c7d2fe;margin-top:6px;">Résultat de votre recherche</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 24px;font-size:15px;color:#374151;">Bonjour,</p>
              <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6;">
                Votre recherche pour <strong>${name}</strong> a abouti. Voici votre numéro D-U-N-S&reg; :
              </p>

              <!-- Result card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7ff;border:1px solid #e0e7ff;border-radius:10px;margin-bottom:28px;">
                <tr>
                  <td style="padding:28px 32px;">
                    <div style="font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entreprise</div>
                    <div style="font-size:17px;font-weight:600;color:#111827;margin-bottom:20px;">${name}</div>

                    <div style="font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Numéro D-U-N-S&reg;</div>
                    <div style="font-size:36px;font-weight:800;color:#4f46e5;letter-spacing:4px;margin-bottom:20px;">${duns}</div>

                    ${address ? `<div style="font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Adresse</div>
                    <div style="font-size:14px;color:#374151;">${address}</div>` : ""}
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
                Merci d'avoir utilisé DUNS Lookup. Ce résultat a été obtenu le ${date} via la base de données publique UPIK de Dun &amp; Bradstreet.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8f7ff;border-top:1px solid #e0e7ff;padding:20px 40px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;">
                Service indépendant, non affilié à Dun &amp; Bradstreet&reg; · Les données proviennent de la base UPIK publique.<br>
                © ${new Date().getFullYear()} DUNS Lookup — dunslookupofficial@gmail.com
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[server] DUNS API listening on port ${PORT}`);
  console.log(`[server] DISPLAY=${process.env.DISPLAY || "(not set)"}`);
  console.log(`[server] RESEND=${RESEND_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`[server] GMAIL=${GMAIL_APP_PASSWORD ? "configured" : "NOT SET"} (user=${GMAIL_USER})`);
  console.log(`[server] CORS origin=${FRONTEND_URL}`);
  // Warm up the browser and pre-cache the UPIK page
  getBrowser().then(async (browser) => {
    try {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const pg = await ctx.newPage();
      await pg.route(/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff|woff2|ttf|eot|otf|mp4|mp3|pdf)(\?.*)?$/i, (r) => r.abort());
      await pg.goto("https://www.dnb.com/de-de/upik.html", { waitUntil: "domcontentloaded", timeout: 60_000 });
      console.log("[server] UPIK page pre-warmed");
      await pg.close().catch(() => {});
      await ctx.close().catch(() => {});
    } catch (err) {
      console.error("[server] pre-warm failed:", err.message);
    }
  }).catch((err) => console.error("[server] browser warm-up failed:", err.message));
});

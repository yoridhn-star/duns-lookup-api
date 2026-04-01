const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3001;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "DUNS Lookup <noreply@yourdomain.com>";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

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
  const { companyName, country = "Frankreich", email } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: "companyName is required" });
  }

  console.log(`[lookup] company="${companyName}" country="${country}" email="${email || "(none)"}"`);

  let context = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
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

    // ── Dismiss cookie banner ─────────────────────────────────────────────
    // Strategy 1: click the "required only" button
    let cookieDismissed = false;
    for (const sel of [
      'button:has-text("Obligatoire uniquement")',
      'button:has-text("Nur erforderliche")',
      'button:has-text("Nur notwendige")',
      'button:has-text("Accept required")',
      '[data-testid="accept-required"]',
      "#onetrust-reject-all-handler",
      'a:has-text("Obligatoire uniquement")',
      'a:has-text("Nur erforderliche")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await btn.click({ timeout: 3_000 });
          console.log(`[lookup] dismissed cookies (click): ${sel}`);
          await page.waitForTimeout(300);
          cookieDismissed = true;
          break;
        }
      } catch { /* try next */ }
    }

    // Strategy 2: remove banner nodes + restore overflow
    if (!cookieDismissed) {
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
      await page.waitForTimeout(200);
    }

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

    // ── Click submit ──────────────────────────────────────────────────────
    console.log("[lookup] clicking submit...");
    const submitBtn = page.locator('button[type="submit"]').filter({
      hasNot: page.locator(':text("Suche löschen")'),
    });
    await submitBtn.first().click();

    // ── Wait for results ───────────────────────────────────────────────────
    console.log("[lookup] waiting for results...");
    await page.waitForFunction(
      () => /D-U-N-S/i.test(document.body.innerText),
      { timeout: 15_000 }
    ).catch(() => console.log("[lookup] result wait timed out — extracting anyway"));

    await page.waitForTimeout(1_000);

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

    // ── Send email via Resend (optional) ──────────────────────────────────
    if (results.length > 0 && email && email.trim() && RESEND_API_KEY) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const resultRows = results
          .map(
            (r, i) =>
              `<tr>
                <td style="padding:8px;border:1px solid #ddd">${i + 1}</td>
                <td style="padding:8px;border:1px solid #ddd">${escapeHtml(r.name)}</td>
                <td style="padding:8px;border:1px solid #ddd"><b>${escapeHtml(r.duns)}</b></td>
                <td style="padding:8px;border:1px solid #ddd">${escapeHtml(r.address)}</td>
              </tr>`
          )
          .join("");

        await resend.emails.send({
          from: EMAIL_FROM,
          to: email.trim(),
          subject: `DUNS Lookup : résultats pour "${companyName}"`,
          html: `
            <h2>Résultats DUNS pour : ${escapeHtml(companyName)}</h2>
            <p>Pays : ${escapeHtml(country)}</p>
            <table style="border-collapse:collapse;width:100%">
              <thead>
                <tr style="background:#f5f5f5">
                  <th style="padding:8px;border:1px solid #ddd">#</th>
                  <th style="padding:8px;border:1px solid #ddd">Entreprise</th>
                  <th style="padding:8px;border:1px solid #ddd">D-U-N-S</th>
                  <th style="padding:8px;border:1px solid #ddd">Adresse</th>
                </tr>
              </thead>
              <tbody>${resultRows}</tbody>
            </table>
            <p style="color:#888;font-size:12px;margin-top:20px">
              Envoyé par DUNS Lookup — ${new Date().toLocaleString("fr-FR")}
            </p>
          `,
        });
        console.log(`[lookup] email sent to ${email}`);
      } catch (mailErr) {
        console.error("[lookup] email send failed:", mailErr.message);
      }
    } else if (email && email.trim() && !RESEND_API_KEY) {
      console.warn("[lookup] RESEND_API_KEY not set — skipping email");
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
  console.log(`[server] CORS origin=${FRONTEND_URL}`);
  // Warm up the browser immediately so the first request doesn't pay launch cost
  getBrowser().catch((err) => console.error("[server] browser warm-up failed:", err.message));
});

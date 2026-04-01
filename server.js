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

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── DUNS Lookup ───────────────────────────────────────────────────────────────

app.post("/api/lookup-duns", async (req, res) => {
  const { companyName, country = "Frankreich", email } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: "companyName is required" });
  }

  console.log(`[lookup] company="${companyName}" country="${country}" email="${email || "(none)"}"`);

  let browser = null;

  try {
    // ── Launch Chromium with Xvfb display ──────────────────────────────────
    // DISPLAY=:99 must be set in the environment (Dockerfile starts Xvfb :99)
    const display = process.env.DISPLAY || ":99";

    browser = await chromium.launch({
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
      env: {
        ...process.env,
        DISPLAY: display,
      },
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });

    // ── Pre-set TrustArc / GDPR consent cookies ───────────────────────────
    // Setting these before navigation prevents the cookie banner from showing
    await context.addCookies([
      { name: "notice_behavior",            value: "expressed,eu", domain: ".dnb.com", path: "/" },
      { name: "notice_gdpr_prefs",          value: "0:1:2",        domain: ".dnb.com", path: "/" },
      { name: "cmapi_cookie_privacy",       value: "permit 1,2,3", domain: ".dnb.com", path: "/" },
      { name: "truste.eu.cookie.notice_gdpr_pr498", value: "1",   domain: ".dnb.com", path: "/" },
    ]);

    const page = await context.newPage();

    // ── Block unnecessary resources to speed up page load ─────────────────
    await page.route(
      /\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff|woff2|ttf|eot|otf|mp4|mp3|pdf)(\?.*)?$/i,
      (route) => route.abort()
    );
    // Also block analytics / tracking / ads that slow down the page
    await page.route(/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar/i, (route) =>
      route.abort()
    );

    // ── Navigate ───────────────────────────────────────────────────────────
    console.log("[lookup] navigating to UPIK...");
    await page.goto("https://www.dnb.com/de-de/upik.html", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    // ── Wait for Cloudflare to clear ───────────────────────────────────────
    // Either the page title contains "UPIK" or the search form appears
    console.log("[lookup] waiting for Cloudflare / page to load...");
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
    // Strategy 1: try to click "Obligatoire uniquement" / "Nur erforderliche"
    let cookieDismissed = false;
    const cookieSelectors = [
      'button:has-text("Obligatoire uniquement")',
      'button:has-text("Nur erforderliche")',
      'button:has-text("Nur notwendige")',
      'button:has-text("Accept required")',
      '[data-testid="accept-required"]',
      "#onetrust-reject-all-handler",
      'a:has-text("Obligatoire uniquement")',
      'a:has-text("Nur erforderliche")',
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await btn.click({ timeout: 3_000 });
          console.log(`[lookup] dismissed cookies (click) with: ${sel}`);
          await page.waitForTimeout(300);
          cookieDismissed = true;
          break;
        }
      } catch {
        // selector not found or click failed — try next
      }
    }

    // Strategy 2 (fallback): remove TrustArc banner nodes directly from the DOM
    if (!cookieDismissed) {
      console.log("[lookup] cookie click failed — removing banner via DOM");
      await page.evaluate(() => {
        const selectors = [
          "#truste-consent-track",
          "#truste-consent-content",
          ".truste-banner-overlay",
          "#trustarc-banner-overlay",
          "#consent_blackbar",
          "#truste-show-consent",
          ".truste_popframe",
          "iframe[id*='trustarc']",
          "iframe[src*='consent.trustarc']",
          "iframe[src*='truste']",
        ];
        selectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });
        // Set consent cookies via JS so they persist across navigation
        const cookiesToSet = [
          "notice_behavior=expressed,eu",
          "notice_gdpr_prefs=0:1:2",
          "cmapi_cookie_privacy=permit 1,2,3",
          "truste.eu.cookie.notice_gdpr_pr498=1",
        ];
        cookiesToSet.forEach((c) => {
          document.cookie = `${c};path=/;domain=.dnb.com`;
        });
        // Restore pointer-events in case the overlay was blocking clicks
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
    console.log(`[lookup] typing company name...`);
    const searchInput = page.locator('input[placeholder="Suche hier..."]');
    await searchInput.waitFor({ state: "visible", timeout: 10_000 });
    await searchInput.fill(companyName.trim());

    // ── Click submit (NOT "Suche löschen") ────────────────────────────────
    // The submit button is button[type="submit"] inside the form.
    // "Suche löschen" is a different element (link/button with that text).
    console.log("[lookup] clicking submit button...");
    const submitBtn = page.locator('button[type="submit"]').filter({
      hasNot: page.locator(':text("Suche löschen")'),
    });
    await submitBtn.first().click();

    // ── Wait for results ───────────────────────────────────────────────────
    console.log("[lookup] waiting for results...");
    // Results appear after 4-6s — wait for result rows or a "no results" message
    await page.waitForFunction(
      () => {
        // Typical result containers on the UPIK page
        const rows = document.querySelectorAll(
          ".result-row, .upik-result, table tbody tr, [class*='result'] tr, [class*='Result'] tr"
        );
        const noResult = document.querySelector(
          "[class*='no-result'], [class*='noResult'], [class*='empty']"
        );
        return rows.length > 0 || noResult !== null;
      },
      { timeout: 15_000 }
    ).catch(() => {
      console.log("[lookup] waitForFunction timed out — will try to extract anyway");
    });

    // Extra buffer so JS can finish rendering
    await page.waitForTimeout(1_000);

    // ── Extract results ────────────────────────────────────────────────────
    console.log("[lookup] extracting results...");
    const results = await page.evaluate(() => {
      const extracted = [];

      // Strategy 1 — structured result rows with labelled cells
      const rows = document.querySelectorAll(
        ".result-row, .upik-result, table tbody tr, [class*='result'] tr, [class*='Result'] tr"
      );

      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll("td, [class*='cell'], [class*='Cell']"));
        if (cells.length === 0) return;

        const texts = cells.map((c) => c.innerText.trim()).filter(Boolean);
        if (texts.length === 0) return;

        // Look for a DUNS-like number (9 digits) in any cell
        const dunsCell = texts.find((t) => /^\d{9}$/.test(t.replace(/[\s\-]/g, "")));
        if (!dunsCell) return;

        extracted.push({
          name: texts[0] || "",
          duns: dunsCell.replace(/[\s\-]/g, ""),
          address: texts.filter((t) => t !== texts[0] && t !== dunsCell).join(", "),
        });
      });

      if (extracted.length > 0) return extracted;

      // Strategy 2 — scan entire page text for DUNS patterns
      const bodyText = document.body.innerText;
      const dunsPattern = /D-U-N-S[^\d]*(\d[\d\s\-]{7,10}\d)/gi;
      let match;
      while ((match = dunsPattern.exec(bodyText)) !== null) {
        extracted.push({
          name: "",
          duns: match[1].replace(/[\s\-]/g, ""),
          address: "",
          raw: true,
        });
      }

      return extracted;
    });

    console.log(`[lookup] found ${results.length} result(s)`);

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
        // Non-fatal — still return results to the caller
      }
    } else if (email && email.trim() && !RESEND_API_KEY) {
      console.warn("[lookup] RESEND_API_KEY not set — skipping email");
    }

    // Build top-level data shortcut (first result) for convenience
    const first = results[0] || null;
    const data = first
      ? { companyName: first.name || companyName, dunsNumber: first.duns, address: first.address }
      : null;

    return res.json({
      success: true,
      companyName,
      country,
      resultsCount: results.length,
      results,
      data,
    });
  } catch (err) {
    console.error("[lookup] error:", err.message);
    return res.status(500).json({
      error: "Lookup failed",
      details: err.message,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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

app.listen(PORT, () => {
  console.log(`[server] DUNS API listening on port ${PORT}`);
  console.log(`[server] DISPLAY=${process.env.DISPLAY || "(not set)"}`);
  console.log(`[server] RESEND=${RESEND_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`[server] CORS origin=${FRONTEND_URL}`);
});

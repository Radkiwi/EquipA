const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Airtable = require("airtable");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const growthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, error: "Too many report requests. Please try again in an hour." },
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests, please try again later." },
});

const base = process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID
  ? new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

app.post("/api/signup", signupLimiter, async (req, res) => {
  const { name, email, organisation, role } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "A valid email address is required." });
  }

  if (!base) {
    console.warn("Airtable not configured — signup received:", { name, email, organisation, role });
    return res.json({ success: true, message: "Kia ora! You're on the list." });
  }

  const baseFields = {
    Name: name || "",
    Email: email,
    Organisation: organisation || "",
    Signup_Date: new Date().toISOString().split("T")[0],
    Source: "Landing Page",
    "Signup Status": "Signed Up",
  };

  try {
    await base("Waitlist").create([{ fields: { ...baseFields, Role: role || "" } }]);
    res.json({ success: true, message: "Kia ora! You're on the list." });
  } catch (err) {
    if (err.message && err.message.includes("INVALID_MULTIPLE_CHOICE_OPTIONS")) {
      // Role field is a singleSelect in Airtable — fall back to saving without it
      try {
        await base("Waitlist").create([{ fields: { ...baseFields, "Interest Notes": role || "" } }]);
        res.json({ success: true, message: "Kia ora! You're on the list." });
      } catch (fallbackErr) {
        console.error("Airtable fallback error:", fallbackErr.message);
        res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
      }
    } else {
      console.error("Airtable error:", err.message);
      res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
    }
  }
});

async function saveGrowthLead(business, targets, proc, bottlenecks) {
  if (!base) return null;
  try {
    const records = await base("Growth Leads").create([{
      fields: {
        "Business Name": business.name || "",
        "Email":         business.email || "",
        "Industry":      business.industry || "",
        "Revenue":       business.revenue || "",
        "Team Size":     business.teamSize || "",
        "Products Services": business.products || "",
        "Target 1yr":    targets.oneYear || "",
        "Target 5yr":    targets.fiveYear || "",
        "Target 10yr":   targets.tenYear || "",
        "Production Goals": targets.productionGoals || "",
        "Process":       proc.description || "",
        "Equipment":     proc.workflow || "",
        "Bottlenecks":   bottlenecks.selected?.join("; ") || "",
        "Bottleneck Details": bottlenecks.freeText || "",
        "Report Date":   new Date().toISOString().split("T")[0],
        "Source":        "Growth Report",
      },
    }]);
    return records[0].id;
  } catch (err) {
    console.error("Airtable lead save error:", err.message);
    return null;
  }
}

async function updateLeadEmail(leadId, email) {
  if (!base || !leadId) return;
  try {
    await base("Growth Leads").update(leadId, { Email: email });
  } catch (err) {
    console.error("Airtable email update error:", err.message);
  }
}

app.post("/api/growth-report", growthLimiter, async (req, res) => {
  const { business, targets, process: proc, bottlenecks } = req.body;

  if (!business?.industry || !business?.products) {
    return res.status(400).json({ success: false, error: "Missing required business profile fields." });
  }

  if (!anthropic) {
    return res.status(503).json({ success: false, error: "Report generation is not yet configured — please add ANTHROPIC_API_KEY." });
  }

  const prompt = `You are a senior business growth consultant specialising in NZ industrial, agricultural, food processing, and production businesses. A business owner has shared their profile, growth goals, and constraints. Generate a professional, personalised growth report in HTML.

Use only semantic HTML with inline styles. For h2 headings use: style="color:#0D2B4E;border-bottom:2px solid #00A99D;padding-bottom:8px;margin:28px 0 14px;font-size:1.2rem;font-family:Arial,sans-serif". For module recommendation cards use: style="border-left:4px solid #00A99D;padding:16px 20px;margin:12px 0;border-radius:6px;background:#f0f9f8;". Body text in #1a1a1a, font-family Arial.

---
BUSINESS PROFILE:
Name: ${business.name || "Not provided"}
Industry: ${business.industry}
Current revenue: ${business.revenue || "Not specified"}
Team size: ${business.teamSize || "Not specified"}
Products/services: ${business.products}

GROWTH TARGETS:
1-year: ${targets.oneYear || "Not specified"}
5-year: ${targets.fiveYear || "Not specified"}
10-year: ${targets.tenYear || "Not specified"}
Production/operational goals: ${targets.productionGoals || "Not specified"}

PROCESS:
${proc.description}
Equipment/infrastructure: ${proc.workflow || "Not specified"}

BOTTLENECKS:
Selected: ${bottlenecks.selected?.join("; ") || "None selected"}
Details: ${bottlenecks.freeText || "None"}
---

Generate these sections:

<h2 ...>Executive Summary</h2>
2-3 paragraphs. Acknowledge their current position, recognise their ambition, and frame how the right infrastructure unlocks their targets. Be specific to their industry and NZ context.

<h2 ...>Growth Gap Analysis</h2>
Analyse what needs to change at each time horizon (1yr, 5yr, 10yr) — operationally, in capacity, equipment, and capability. Be concrete and specific.

<h2 ...>Bottleneck Assessment</h2>
Assess each bottleneck they identified. Why does it exist in NZ's context? What is the downstream impact on their targets? What category of solution is required?

<h2 ...>Your equipA Roadmap</h2>
For each genuinely relevant module, create a recommendation card with the module name as a bold heading, a one-line relevance statement, and 2-3 specific actions. Only include modules that directly address their situation. Available modules:
- Market (Marketplace): source new, used, refurbished equipment from NZ dealers and fleets
- Lab (Shared Access): access R&D and testing equipment at CRIs and universities
- Care (Maintenance): lifecycle management, servicing, calibration, heavy rigging
- Safe (Compliance): WorkSafe NZ, LEENZ, custom SOPs and safety documentation
- Learn (Knowledge): operator training, knowledge transfer, machine-specific guides
- Loop (Circularity): trade-ins, refurbishment, parts salvaging, carbon tracking
- Finance (Finance): lease-to-own, fractional ownership, structured payment plans
- Sure (Insurance): transit, mechanical breakdown, liability for industrial equipment

<h2 ...>90-Day Action Plan</h2>
Three phases with specific, actionable steps tied to their situation:
- Days 1–30: Immediate assessment and quick wins
- Days 31–60: Procurement, process changes, and partnerships
- Days 61–90: Capability building and scaling

Address the owner directly as "you". Reference NZ context (WorkSafe, NZTE, Callaghan Innovation, etc.) where relevant. Total length: approximately 900–1,200 words.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    });
    const leadId = await saveGrowthLead(business, targets, proc, bottlenecks);
    res.json({ success: true, report: message.content[0].text, leadId });
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(500).json({ success: false, error: "Failed to generate report. Please try again." });
  }
});

app.post("/api/send-report", async (req, res) => {
  const { email, reportHtml, businessName, leadId } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "A valid email address is required." });
  }

  if (!resend) {
    return res.status(503).json({ success: false, error: "Email sending is not yet configured." });
  }

  const date = new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });
  const fromAddress = process.env.RESEND_FROM || "equipA Growth Reports <reports@equipa.kiwi>";

  const emailHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your equipA Growth Report</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:24px 0;">
  <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="background:#0D2B4E;padding:30px 40px;text-align:center;">
      <div style="font-size:1.3rem;font-weight:800;letter-spacing:-0.5px;">
        <span style="color:#00A99D;">equip</span><span style="color:#fff;">A</span><span style="color:#fff;">.kiwi</span>
      </div>
      <p style="color:rgba(255,255,255,0.55);margin:8px 0 0;font-size:0.88rem;">Your personalised business growth report</p>
    </div>
    <div style="padding:32px 40px 0;border-bottom:1px solid #eee;">
      <h1 style="color:#0D2B4E;font-size:1.35rem;margin:0 0 6px;">Business Growth Report</h1>
      <p style="color:#888;font-size:0.85rem;margin:0 0 24px;">${businessName ? businessName + " · " : ""}Generated ${date}</p>
    </div>
    <div style="padding:32px 40px;font-size:15px;line-height:1.72;color:#1a1a1a;">
      ${reportHtml}
    </div>
    <div style="background:#f8f8f8;padding:24px 40px;border-top:1px solid #eee;text-align:center;">
      <p style="color:#888;font-size:0.8rem;margin:0;">Generated by <strong style="color:#0D2B4E;">equipA.kiwi</strong> — Aotearoa's industrial equipment ecosystem</p>
      <p style="color:#bbb;font-size:0.75rem;margin:6px 0 0;">equipa.rad.kiwi</p>
    </div>
  </div>
</body></html>`;

  try {
    await resend.emails.send({
      from: fromAddress,
      to: [email],
      bcc: ["alex@rad.kiwi"],
      subject: `Your equipA Growth Report${businessName ? " — " + businessName : ""}`,
      html: emailHtml,
    });
    await updateLeadEmail(leadId, email);
    res.json({ success: true });
  } catch (err) {
    console.error("Resend error:", err.message);
    res.status(500).json({ success: false, error: "Failed to send email. Please download the report instead." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`equipA.kiwi running on port ${PORT}`);
});

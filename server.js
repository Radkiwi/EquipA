const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Airtable = require("airtable");
const Anthropic = require("@anthropic-ai/sdk");
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
    res.json({ success: true, report: message.content[0].text });
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(500).json({ success: false, error: "Failed to generate report. Please try again." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`equipA.kiwi running on port ${PORT}`);
});

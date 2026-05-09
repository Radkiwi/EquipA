const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Airtable = require("airtable");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests, please try again later." },
});

const base = process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID
  ? new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)
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

  try {
    await base("Waitlist").create([
      {
        fields: {
          Name: name || "",
          Email: email,
          Organisation: organisation || "",
          Role: role || "",
          Signup_Date: new Date().toISOString().split("T")[0],
          Source: "Landing Page",
          "Signup Status": "Signed Up",
        },
      },
    ]);
    res.json({ success: true, message: "Kia ora! You're on the list." });
  } catch (err) {
    console.error("Airtable error:", err.message);
    res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`equipA.kiwi running on port ${PORT}`);
});

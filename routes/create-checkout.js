import express from "express";
import Stripe from "stripe";
import jwt from "jsonwebtoken";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// CREATE STRIPE CHECKOUT SESSION
router.post("/create-checkout-session", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email;

    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: "Missing plan" });

    // 🔒 Map plans to Stripe price links
    const PRICE_MAP = {
      Standard: process.env.STRIPE_PRICE_STANDARD,
      Premium: process.env.STRIPE_PRICE_PREMIUM
    };

    if (!PRICE_MAP[plan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price: PRICE_MAP[plan],
          quantity: 1
        }
      ],
      metadata: {
        plan
      },
      success_url: "https://spotalert.live/dashboard.html?payment=success",
      cancel_url: "https://spotalert.live/plans.html?payment=cancel"
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

export default router;

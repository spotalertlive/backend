import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe requires RAW body
router.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email;
      const plan = session.metadata?.plan;

      if (email && plan) {
        const db = req.app.get("db");
        await db.run("UPDATE users SET plan=? WHERE email=?", plan, email);
        console.log(`✅ Plan updated: ${email} → ${plan}`);
      }
    }

    res.json({ received: true });
  }
);

export default router;

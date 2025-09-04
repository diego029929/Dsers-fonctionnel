// ⚡️ Test Stripe Checkout (minimal, sans BDD)
app.post("/test-checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Produit test" },
            unit_amount: 1000, // 10,00 €
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
    });

    res.json({ id: session.id, url: session.url });
  } catch (err: any) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

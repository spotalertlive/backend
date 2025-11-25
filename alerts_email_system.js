// alerts_email_system.js
// Handles email alerts for SpotAlert via AWS SES or SMTP relay

const emailAPI = "https://api.spotalert.live/sendAlert"; // replace with actual backend endpoint

// Function: Send alert email with snapshot attached
async function sendEmailAlert(userEmail, imageURL, cameraName) {
  try {
    const response = await fetch(emailAPI, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: userEmail,
        subject: `SpotAlert Notification - Unknown Face Detected (${cameraName})`,
        html: `
          <h2>🚨 SpotAlert Notification</h2>
          <p>An unknown person was detected by your camera: <strong>${cameraName}</strong>.</p>
          <p>See the snapshot below:</p>
          <img src="${imageURL}" style="max-width:400px;border-radius:6px;" />
          <p>You can log in to your dashboard for full tracking history.</p>
        `,
      }),
    });

    if (!response.ok) throw new Error("Failed to send email");
    console.log("✅ Email sent successfully to", userEmail);
  } catch (err) {
    console.error("❌ Email sending failed:", err);
  }
}

// Example: simulate trigger
// sendEmailAlert("customer@email.com", "https://spotalert.live/snapshot.jpg", "Front Door Camera");

// Fetch email alert logs (admin view)
async function fetchEmailLogs() {
  try {
    const response = await fetch(`${emailAPI}/logs`);
    const logs = await response.json();
    console.table(logs);
    return logs;
  } catch (err) {
    console.error("❌ Failed to fetch email logs:", err);
  }
}

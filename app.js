const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const env = require("dotenv");
const supabase = require("./supabase.js"); // sesuaikan path-nya
const nodemailer = require("nodemailer");

// Load environment variables dari file .env
env.config();
const {
  getTPPKUsers,
  getUserFCMToken,
  saveNotificationToDatabase,
  sendFCMNotification,
} = require("./notifikasi.controller.js");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin hanya sekali
let firebaseInitialized = false;

const initializeFirebase = () => {
  if (!firebaseInitialized) {
    try {
      // Cek apakah sudah ada app yang diinisialisasi
      if (admin.apps.length === 0) {
        let serviceAccount;

        // Support untuk environment variables di Vercel
        // Support untuk environment variables di Vercel
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
          console.log(
            "ℹ️ FIREBASE_SERVICE_ACCOUNT_KEY env variable ditemukan."
          );
          try {
            serviceAccount = JSON.parse(
              process.env.FIREBASE_SERVICE_ACCOUNT_KEY
            );
            console.log("ℹ️ Berhasil parsing FIREBASE_SERVICE_ACCOUNT_KEY.");
          } catch (parseError) {
            console.error(
              "❌ Gagal parsing FIREBASE_SERVICE_ACCOUNT_KEY:",
              parseError
            );
            throw parseError;
          }
        } else {
          console.log(
            "⚠️ FIREBASE_SERVICE_ACCOUNT_KEY env variable tidak ditemukan, fallback ke file JSON."
          );
          serviceAccount = require("./firebase-service-account-key.json");
        }

        console.log("ℹ️ Inisialisasi Firebase dengan serviceAccount:", {
          project_id: serviceAccount.project_id,
          client_email: serviceAccount.client_email,
          // Jangan log private_key ya karena sensitif
        });

        serviceAccount.private_key = serviceAccount.private_key.replace(
          /\\n/g,
          "\n"
        );

        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
      firebaseInitialized = true;
      console.log("✅ Firebase initialized successfully");
    } catch (error) {
      console.error("❌ Error initializing Firebase:", error);
      throw error;
    }
  }
};

// Initialize Firebase
initializeFirebase();

// Function untuk mengirim notifikasi FCM

// Endpoint untuk mengirim notifikasi laporan baru
app.post("/api/notifications/new-report", async (req, res) => {
  try {
    console.log("➡️ Received new-report notification request");
    const { reportId, reportNumber, schoolId, reporterName, incidentCategory } =
      req.body;
    console.log("📥 Request body:", req.body);

    // Validasi input
    if (!reportId || !reportNumber || !schoolId) {
      console.warn("⚠️ Missing required fields");
      return res.status(400).json({
        success: false,
        error: "Missing required fields: reportId, reportNumber, schoolId",
      });
    }

    // Dapatkan semua TPPK di sekolah tersebut
    console.log(`🔍 Fetching TPPK users for schoolId: ${schoolId}`);
    const tppkUsers = await getTPPKUsers(schoolId);
    console.log(`✅ Found ${tppkUsers.length} TPPK users`);

    if (tppkUsers.length === 0) {
      console.warn("⚠️ No TPPK users found for this school");
      return res.status(404).json({
        success: false,
        error: "No TPPK users found for this school",
      });
    }

    // Siapkan data notifikasi
    const notificationTitle = "📋 Laporan Baru";
    const notificationBody = `Laporan ${reportNumber} dari ${
      reporterName || "Siswa"
    } - ${incidentCategory}`;
    const notificationData = {
      type: "new_report",
      report_id: reportId,
      report_number: reportNumber,
      incident_category: incidentCategory,
      reporter_name: reporterName || "",
    };

    const results = [];

    // Kirim notifikasi ke setiap TPPK
    for (const tppk of tppkUsers) {
      console.log(
        `🔔 Processing notification for TPPK user ${tppk.id} (${tppk.full_name})`
      );
      try {
        // Simpan notifikasi ke database terlebih dahulu
        await saveNotificationToDatabase(
          tppk.id,
          notificationTitle,
          notificationBody,
          notificationData
        );
        console.log(`💾 Notification saved to DB for user ${tppk.id}`);

        // Kirim FCM notification jika ada token
        if (tppk.fcm_token) {
          console.log(
            `🚀 Sending FCM notification to token: ${tppk.fcm_token}`
          );
          const fcmResult = await sendFCMNotification(
            tppk.fcm_token,
            notificationTitle,
            notificationBody,
            notificationData
          );

          console.log(
            `✅ FCM sent: ${fcmResult.success} ${
              fcmResult.error ? "- Error: " + fcmResult.error : ""
            }`
          );
          results.push({
            userId: tppk.id,
            userName: tppk.full_name,
            fcmSent: fcmResult.success,
            fcmError: fcmResult.error || null,
          });
        } else {
          console.warn(`⚠️ No FCM token available for user ${tppk.id}`);
          results.push({
            userId: tppk.id,
            userName: tppk.full_name,
            fcmSent: false,
            fcmError: "No FCM token available",
          });
        }
      } catch (error) {
        console.error(
          `❌ Error processing notification for TPPK ${tppk.id}:`,
          error
        );
        results.push({
          userId: tppk.id,
          userName: tppk.full_name,
          fcmSent: false,
          fcmError: error.message,
        });
      }
    }

    console.log(`🎉 Notifications sent to ${tppkUsers.length} TPPK users`);
    res.json({
      success: true,
      message: `Notifications sent to ${tppkUsers.length} TPPK users`,
      results,
    });
  } catch (error) {
    console.error("❌ Error in new-report notification endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk update FCM token user
app.post("/api/notifications/update-fcm-token", async (req, res) => {
  try {
    console.log("➡️ Received request to update FCM token");
    const { userId, fcmToken } = req.body;
    console.log(`📥 Request body: userId=${userId}, fcmToken=${fcmToken}`);

    if (!userId || !fcmToken) {
      console.warn("⚠️ Missing userId or fcmToken in request");
      return res.status(400).json({
        success: false,
        error: "Missing userId or fcmToken",
      });
    }

    const { error } = await supabase
      .from("users")
      .update({
        fcm_token: fcmToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (error) {
      console.error("❌ Supabase update error:", error);
      throw error;
    }

    console.log(`✅ FCM token updated successfully for userId: ${userId}`);

    res.json({
      success: true,
      message: "FCM token updated successfully",
    });
  } catch (error) {
    console.error("❌ Error updating FCM token:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk mendapatkan notifikasi user
app.get("/api/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20, isRead } = req.query;

    let query = supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    // Filter berdasarkan status baca jika disediakan
    if (isRead !== undefined) {
      query = query.eq("is_read", isRead === "true");
    }

    // Pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);

    const { data: notifications, error, count } = await query;

    if (error) {
      throw error;
    }

    // Parse JSON data field
    const parsedNotifications = notifications.map((notification) => ({
      ...notification,
      data: notification.data ? JSON.parse(notification.data) : {},
    }));

    res.json({
      success: true,
      notifications: parsedNotifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching notifications:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk menandai notifikasi sebagai sudah dibaca
app.patch("/api/notifications/:notificationId/read", async (req, res) => {
  try {
    const { notificationId } = req.params;

    const { error } = await supabase
      .from("notifications")
      .update({
        is_read: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", notificationId);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("❌ Error marking notification as read:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk menandai semua notifikasi user sebagai sudah dibaca
app.patch("/api/notifications/:userId/mark-all-read", async (req, res) => {
  try {
    const { userId } = req.params;

    const { error } = await supabase
      .from("notifications")
      .update({
        is_read: true,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("is_read", false);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("❌ Error marking all notifications as read:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk menghitung jumlah notifikasi yang belum dibaca
app.get("/api/notifications/:userId/unread-count", async (req, res) => {
  try {
    const { userId } = req.params;

    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_read", false);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      unreadCount: count,
    });
  } catch (error) {
    console.error("❌ Error getting unread count:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint untuk testing FCM
app.post("/api/send-verification-email", async (req, res) => {
  try {
    console.log("Request body:", req.body);

    const { email } = req.body;

    if (!email) {
      console.warn("Missing 'email' in request body");
      return res.status(400).json({
        success: false,
        error: "Missing 'email' in request body",
      });
    }

    console.log("EMAIL_USER env:", process.env.EMAIL_USER);
    // Jangan print password kalau di production, ini cuma debugging
    console.log("EMAIL_PASS env is set:", !!process.env.EMAIL_PASS);

    const transporter = nodemailer.createTransporter({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Akun Anda di SiPPKe sudah terverifikasi`,
      html: `
    <p>Halo,</p>

    <p>Akun Anda di Sistem Pencegahan dan Penanganan Kekerasan (SiPPKe) sudah berhasil diverifikasi.</p>

    <p>Sekarang Anda bisa login dan mulai menggunakan layanan kami.</p>

    <p>Kalau ada pertanyaan atau butuh bantuan, jangan ragu untuk menghubungi kami.</p>

    <p>Terima kasih sudah menggunakan SiPPKe!</p>

    <p>Salam,<br/>
    Tim SiPPKe</p>
  `,
    };

    console.log("Sending mail with options:", mailOptions);

    const info = await transporter.sendMail(mailOptions);

    console.log("Mail sent successfully:", info);

    res.status(200).json({
      success: true,
      message: "Verification email sent successfully",
      info,
    });
  } catch (error) {
    console.error("Error sending verification email:", error);
    if (error.response) {
      console.error("SMTP Response:", error.response);
    }
    if (error.stack) {
      console.error(error.stack);
    }
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

app.post("/api/notifications/test", async (req, res) => {
  try {
    const {
      userId,
      title = "Test Notification",
      body = "This is a test notification",
    } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId",
      });
    }

    const fcmToken = await getUserFCMToken(userId);

    if (!fcmToken) {
      return res.status(404).json({
        success: false,
        error: "FCM token not found for user",
      });
    }

    const result = await sendFCMNotification(fcmToken, title, body, {
      type: "test",
    });

    res.json({
      success: result.success,
      message: result.success
        ? "Test notification sent"
        : "Failed to send notification",
      error: result.error || null,
    });
  } catch (error) {
    console.error("❌ Error sending test notification:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Notification service is running",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    vercel: !!process.env.VERCEL,
  });
});

// Error handler middleware
app.use((error, req, res, next) => {
  console.error("❌ Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: error.message,
    timestamp: new Date().toISOString(),
  });
});

// FIXED: 404 handler - Express v5 compatible wildcard route
// Use /*splat instead of "*" for Express v5 compatibility
app.use("/*splat", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.originalUrl,
    method: req.method,
  });
});

// Export untuk Vercel
module.exports = app;

// Hanya jalankan server jika tidak di Vercel
if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Notification service running on port ${PORT}`);
  });
}

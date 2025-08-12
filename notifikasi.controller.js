const admin = require("firebase-admin");
const supabase = require("./supabase");
async function sendFCMNotification(fcmToken, title, body, data = {}) {
  try {
    const message = {
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      token: fcmToken,
      android: {
        notification: {
          channelId: "sippke_reports",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            badge: 1,
            sound: "default",
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log("✅ FCM notification sent successfully:", response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error("❌ Error sending FCM notification:", error);
    return { success: false, error: error.message };
  }
}

// Function untuk menyimpan notifikasi ke database
async function saveNotificationToDatabase(userId, title, body, data = {}) {
  try {
    const notificationData = {
      user_id: userId,
      title,
      body,
      data: JSON.stringify(data),
      is_read: false,
      created_at: new Date().toISOString(),
    };

    const { data: savedNotification, error } = await supabase
      .from("notifications")
      .insert(notificationData)
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log("✅ Notification saved to database:", savedNotification.id);
    return savedNotification;
  } catch (error) {
    console.error("❌ Error saving notification to database:", error);
    throw error;
  }
}

// Function untuk mendapatkan FCM token user
async function getUserFCMToken(userId) {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("fcm_token")
      .eq("id", userId)
      .single();

    if (error) {
      throw error;
    }

    return user?.fcm_token;
  } catch (error) {
    console.error("❌ Error getting user FCM token:", error);
    return null;
  }
}

// Function untuk mendapatkan semua TPPK dalam sekolah
async function getTPPKUsers(schoolId) {
  try {
    const { data: tppkUsers, error } = await supabase
      .from("users")
      .select("id, fcm_token, full_name")
      .eq("school_id", schoolId)
      .eq("role", "tppk")
      .eq("is_active", true);

    if (error) {
      throw error;
    }

    return tppkUsers || [];
  } catch (error) {
    console.error("❌ Error getting TPPK users:", error);
    return [];
  }
}

module.exports = {
  getTPPKUsers,
  getUserFCMToken,
  saveNotificationToDatabase,
  sendFCMNotification,
};

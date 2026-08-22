import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Single i18n instance (AR first; FR slots reserved). UI strings live here,
 * and server error keys (AUTH_REQUIRED, FORBIDDEN, WRONG_BUILD_SECRET, ...)
 * resolve through the same table, so a message stays meaningful and
 * translatable without touching the api.
 */
const resources = {
  ar: {
    translation: {
      appTitle: "دكان",
      appSub: "متجر إكسسوارات السيارات",
      loginHeading: "تسجيل الدخول",
      username: "رقم الهاتف",
      password: "كلمة السر",
      login: "دخول",
      logout: "خروج",
      firstTime: "المرة الأولى؟ أنشئ كلمة السر بالرمز السري",
      setupHeading: "الإعداد الأول (الرمز السري)",
      secret: "الرمز السري",
      resetDone: "تم الإعداد، سجّل الدخول الآن",
      resetBusy: "جاري الإعداد…",
      home: "تم تسجيل الدخول بنجاح",
      homeHint: "يمكنك القدوم إلى المتجر وبدء البيع.",
      unexpected: "حدث خطأ غير متوقع",
      // server error keys -> user text
      AUTH_REQUIRED: "تسجيل الدخول مطلوب",
      FORBIDDEN: "هذا الحساب غير مخوّل",
      SIGNUP_FORBIDDEN: "إنشاء الحسابات غير مسموح؛ استخدم الرمز السري للتهيئة",
      INVALID_PHONE_NUMBER: "رقم الهاتف غير صالح",
      WRONG_BUILD_SECRET: "الرمز السري غير صحيح",
      UNEXPECTED: "حدث خطأ غير متوقع",
    },
  },
} as const;

export type MessageKey = keyof (typeof resources)["ar"]["translation"];

/** Translate a server error key; unknown keys fall back to the message itself. */
export function tError(message: string | undefined): string {
  // SAFETY: unknown keys fall back to their own text; the cast only narrows the lookup type
  return i18n.t(message as MessageKey, { defaultValue: message ?? "UNEXPECTED" });
}

void i18n.use(initReactI18next).init({
  resources,
  lng: "ar",
  fallbackLng: "ar",
  interpolation: { escapeValue: false },
});

export default i18n;
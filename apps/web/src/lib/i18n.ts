import i18n from "i18next";
import { initReactI18next } from "react-i18next";

<<<<<<< HEAD
/**
 * Single i18n instance, Arabic only. UI strings live here,
 * and server error keys (AUTH_REQUIRED, FORBIDDEN, WRONG_BUILD_SECRET, ...)
 * resolve through the same table, so a message stays meaningful and
 * translatable without touching the api.
=======
import type { DokanClient } from "@dokan/contracts";

/**
 * Single i18n instance (AR first; FR slots reserved). UI strings and server
 * error keys (CATEGORY_EXISTS, CATEGORY_NOT_FOUND, ITEM_NOT_FOUND, ...) live
 * here; the api never ships display text.
>>>>>>> 0f08f6a (PR16 review: update-category validation, error keys + web i18next, dynamic ports (env + fallback), 127.0.0.1 e2e hosts, e2e stable defaults)
 */
const resources = {
  ar: {
    translation: {
      appTitle: "دكان",
<<<<<<< HEAD
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
      BUILD_SECRET_NOT_CONFIGURED: "لم يتم ضبط الرمز السري بعد",
=======
      navCategories: "التصنيفات",
      navItems: "المنتجات",
      dashboardTitle: "الرئيسية",
      dashboardItemsCount: "عدد المنتجات",
      dashboardCategoriesCount: "عدد التصنيفات",
      dashboardLowStock: "منتجات على وشك النفاد",
      dashboardLowStockEmpty: "لا توجد منتجات منخفضة حالياً",
      categoriesTitle: "التصنيفات",
      categoriesNewName: "اسم تصنيف جديد",
      categoriesAdd: "إضافة",
      categoriesEmpty: "لا توجد تصنيفات بعد",
      itemsTitle: "المنتجات",
      itemsName: "الاسم",
      itemsCategory: "التصنيف",
      itemsCost: "سعر الشراء (دج)",
      itemsSell: "سعر البيع (دج)",
      itemsThreshold: "حد التنبيه",
      itemsSave: "حفظ",
      itemsLowBadge: "منخفض",
      itemsSellAboveCost: "سعر البيع يجب أن يكون عدداً موجباً",
      itemsChooseCategory: "اختر تصنيفاً أو أنشئه أولاً",
      itemsProfitPerUnit: "الربح لكل وحدة: {{profit}} دج",
      itemsUncategorized: "بدون تصنيف",
      // server error keys -> user text
      CATEGORY_EXISTS: "هذا التصنيف موجود مسبقاً",
      CATEGORY_NOT_FOUND: "التصنيف غير موجود",
      ITEM_NOT_FOUND: "المنتج غير موجود",
      ITEM_ERROR: "تعذّر حفظ المنتج",
>>>>>>> 0f08f6a (PR16 review: update-category validation, error keys + web i18next, dynamic ports (env + fallback), 127.0.0.1 e2e hosts, e2e stable defaults)
      UNEXPECTED: "حدث خطأ غير متوقع",
    },
  },
} as const;

<<<<<<< HEAD
export type MessageKey = keyof (typeof resources)["ar"]["translation"];

/** Translate a server error key; unknown keys fall back to the message itself. */
export function tError(message: string | undefined): string {
  // SAFETY: unknown keys fall back to their own text; the cast only narrows the lookup type
  return i18n.t(message as MessageKey, { defaultValue: message ?? "UNEXPECTED" });
}

=======
/** Translate a server error key; unknown keys fall back to a generic error. */
export function tError(message: string | undefined): string {
  // SAFETY: unknown keys fall back to UNEXPECTED; the cast only narrows the lookup type
  return i18n.t(message as keyof (typeof resources)["ar"]["translation"], { defaultValue: "UNEXPECTED" });
}

export type DokanClientWithI18n = DokanClient;

>>>>>>> 0f08f6a (PR16 review: update-category validation, error keys + web i18next, dynamic ports (env + fallback), 127.0.0.1 e2e hosts, e2e stable defaults)
void i18n.use(initReactI18next).init({
  resources,
  lng: "ar",
  fallbackLng: "ar",
  interpolation: { escapeValue: false },
});

export default i18n;
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Single i18n instance, Arabic only. UI strings and server error keys live
 * here; the api never ships display text.
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
      AUTH_REQUIRED: "تسجيل الدخول مطلوب",
      FORBIDDEN: "هذا الحساب غير مخوّل",
      SIGNUP_FORBIDDEN: "إنشاء الحسابات غير مسموح؛ استخدم الرمز السري للتهيئة",
      INVALID_PHONE_NUMBER: "رقم الهاتف غير صالح",
      WRONG_BUILD_SECRET: "الرمز السري غير صحيح",
      BUILD_SECRET_NOT_CONFIGURED: "لم يتم ضبط الرمز السري بعد",
      CATEGORY_EXISTS: "هذا التصنيف موجود مسبقاً",
      CATEGORY_NOT_FOUND: "التصنيف غير موجود",
      ITEM_NOT_FOUND: "المنتج غير موجود",
      ITEM_ERROR: "تعذّر حفظ المنتج",
      UNEXPECTED: "حدث خطأ غير متوقع",
    },
  },
} as const;

export type MessageKey = keyof (typeof resources)["ar"]["translation"];

/** Translate a server error key; unknown keys fall back to UNEXPECTED. */
export function tError(message: string | undefined): string {
  // SAFETY: unknown keys fall back to UNEXPECTED; the cast only narrows the lookup type
  return i18n.t(message as MessageKey, { defaultValue: "UNEXPECTED" });
}

void i18n.use(initReactI18next).init({
  resources,
  lng: "ar",
  fallbackLng: "ar",
  interpolation: { escapeValue: false },
});

export default i18n;
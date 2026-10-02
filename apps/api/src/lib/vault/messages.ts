import { MIN_VAULT_PASSPHRASE_LENGTH } from "@dokan/contracts";

/** Re-exported so API modules have a single import for vault limits + copy. */
export { MIN_VAULT_PASSPHRASE_LENGTH };

/**
 * Stable vault error codes mapped to the Arabic text the owner reads. Shared
 * by the HTTP gate and the stdin broker so the two transports can never say
 * different things about the same failure.
 */
const ERROR_TEXT_ENTRIES: ReadonlyArray<readonly [code: string, text: string]> = [
  ["VAULT_WRONG_PASSPHRASE", "كلمة المرور غير صحيحة. تحقّق منها ثم أعد المحاولة."],
  ["VAULT_WRONG_RECOVERY", "مفتاح الاسترداد غير صحيح. تحقّق منه ثم أعد المحاولة."],
  ["VAULT_LOCKED", "محاولات خاطئة كثيرة. انتظر قليلاً ثم أعد المحاولة."],
  ["VAULT_ALREADY_CONFIGURED", "الخزنة مُنشأة بالفعل على هذا الجهاز."],
  ["VAULT_INVALID", "تعذّر فتح الخزنة: ملف الإعدادات تالف. لا يمكن المتابعة على هذا النسخ."],
  ["VAULT_NOT_UNLOCKED", "الخزنة مقفلة."],
  ["VAULT_RECOVERY_LIMIT", "لا يمكن إضافة أكثر من خمسة مفاتيح استرداد."],
  ["VAULT_RECOVERY_NOT_FOUND", "مفتاح الاسترداد غير موجود."],
  ["VAULT_PASSPHRASE_TOO_SHORT", `كلمة المرور قصيرة جداً (${MIN_VAULT_PASSPHRASE_LENGTH} أحرف على الأقل).`],
  ["VAULT_SETUP_TOKEN_REQUIRED", "رمز التهيئة مفقود أو غير صحيح."],
  ["VAULT_SETUP_FAILED", "تعذّر تجهيز الخزنة. لم تتغيّر أي بيانات؛ أعد المحاولة."],
  ["VAULT_SCHEMA_TOO_NEW", "تعذّر فتح البيانات: هذه النسخة من التطبيق أقدم من قاعدة البيانات. حدّث دكان ثم أعد المحاولة."],
];

export function vaultErrorMessage(code: string): string {
  return ERROR_TEXT_ENTRIES.find(([key]) => key === code)?.[1] ?? "حدث خطأ غير متوقع";
}

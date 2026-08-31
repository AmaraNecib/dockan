import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Laptop, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

const CYCLE = ["light", "dark", "system"] as const;

const ICONS = {
  light: Sun,
  dark: Moon,
  system: Laptop,
} as const;

export function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  // SAFETY: theme is always one of light/dark/system from next-themes
  const Icon = ICONS[theme as keyof typeof ICONS] ?? Sun;

  function cycle() {
    // SAFETY: theme is always one of light/dark/system from next-themes
    const idx = CYCLE.indexOf((theme ?? "system") as (typeof CYCLE)[number]);
    const next = CYCLE[(idx + 1) % CYCLE.length] ?? "light";
    setTheme(next);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("themeLabel")}
      title={t("themeLabel")}
      onClick={cycle}
    >
      <Icon size={18} />
    </Button>
  );
}

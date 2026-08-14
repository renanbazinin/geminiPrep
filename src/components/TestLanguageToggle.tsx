import { Languages } from "lucide-react";
import { useTestLanguage } from "../contexts/TestLanguageContext";

export function TestLanguageToggle() {
  const { language, setLanguage } = useTestLanguage();
  return (
    <div className="language-toggle" aria-label={language === "en" ? "Test language" : "שפת אזור הבדיקות"}>
      <Languages size={15} />
      <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")} lang="en">EN</button>
      <span>/</span>
      <button className={language === "he" ? "active" : ""} onClick={() => setLanguage("he")} lang="he">עב</button>
    </div>
  );
}


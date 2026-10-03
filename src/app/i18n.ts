import i18n from "i18next";
import { initReactI18next } from "react-i18next";
i18n.use(initReactI18next).init({ resources: { zh: { translation: { title: "法庭证据展示与庭审顺序控制", control: "庭审控制", public: "公开屏", timeline: "庭审时间线" } }, en: { translation: { title: "Court Evidence Control", control: "Court control", public: "Public display", timeline: "Court timeline" } } }, lng: "zh", fallbackLng: "zh", interpolation: { escapeValue: false } });
export default i18n;

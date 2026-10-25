export interface Country {
  iso: string;
  name: string;
  flag: string;
  indeedDomain: string;
  linkedinLocation: string;
  languages: string[];
  priority: number;
  enabled: boolean;
}

export const COUNTRIES: Country[] = [
  {
    iso: "DE",
    name: "Germany",
    flag: "🇩🇪",
    indeedDomain: "de.indeed.com",
    linkedinLocation: "Germany",
    languages: ["de", "en"],
    priority: 1,
    enabled: true,
  },
  {
    iso: "CA",
    name: "Canada",
    flag: "🇨🇦",
    indeedDomain: "ca.indeed.com",
    linkedinLocation: "Canada",
    languages: ["en", "fr"],
    priority: 2,
    enabled: true,
  },
  {
    iso: "AU",
    name: "Australia",
    flag: "🇦🇺",
    indeedDomain: "au.indeed.com",
    linkedinLocation: "Australia",
    languages: ["en"],
    priority: 3,
    enabled: true,
  },
  {
    iso: "NL",
    name: "Netherlands",
    flag: "🇳🇱",
    indeedDomain: "nl.indeed.com",
    linkedinLocation: "Netherlands",
    languages: ["nl", "en"],
    priority: 4,
    enabled: true,
  },
  {
    iso: "IE",
    name: "Ireland",
    flag: "🇮🇪",
    indeedDomain: "ie.indeed.com",
    linkedinLocation: "Ireland",
    languages: ["en"],
    priority: 5,
    enabled: true,
  },
  {
    iso: "SG",
    name: "Singapore",
    flag: "🇸🇬",
    indeedDomain: "sg.indeed.com",
    linkedinLocation: "Singapore",
    languages: ["en"],
    priority: 6,
    enabled: true,
  },
  {
    iso: "AE",
    name: "UAE",
    flag: "🇦🇪",
    indeedDomain: "ae.indeed.com",
    linkedinLocation: "United Arab Emirates",
    languages: ["en", "ar"],
    priority: 7,
    enabled: true,
  },
  {
    iso: "SE",
    name: "Sweden",
    flag: "🇸🇪",
    indeedDomain: "se.indeed.com",
    linkedinLocation: "Sweden",
    languages: ["sv", "en"],
    priority: 8,
    enabled: true,
  },
  {
    iso: "GB",
    name: "United Kingdom",
    flag: "🇬🇧",
    indeedDomain: "uk.indeed.com",
    linkedinLocation: "United Kingdom",
    languages: ["en"],
    priority: 9,
    enabled: true,
  },
  {
    iso: "SA",
    name: "Saudi Arabia",
    flag: "🇸🇦",
    indeedDomain: "sa.indeed.com",
    linkedinLocation: "Saudi Arabia",
    languages: ["ar", "en"],
    priority: 10,
    enabled: true,
  },
  {
    iso: "QA",
    name: "Qatar",
    flag: "🇶🇦",
    indeedDomain: "qa.indeed.com",
    linkedinLocation: "Qatar",
    languages: ["ar", "en"],
    priority: 11,
    enabled: true,
  },
  {
    iso: "MY",
    name: "Malaysia",
    flag: "🇲🇾",
    indeedDomain: "my.indeed.com",
    linkedinLocation: "Malaysia",
    languages: ["en", "ms"],
    priority: 12,
    enabled: true,
  },
];

export function countryByIso(iso: string): Country | undefined {
  return COUNTRIES.find((c) => c.iso === iso.toUpperCase());
}

export function enabledCountries(): Country[] {
  return COUNTRIES.filter((c) => c.enabled);
}

// Built-in word lists of the sample data generator (src/sampledata.ts): made
// up for test data, no external source. Names come from many languages;
// e-mail addresses use the reserved example domains (RFC 2606) so no
// generated address can belong to anyone.

const split = (s: string) => s.trim().split(/\s+/);

export const FIRST_NAMES = split(`
  Aaliyah Adam Ahmed Aisha Alba Alejandro Alice Amara Amir Ana Anders Andrea Anna Arjun Astrid Ava Ayumi
  Bas Beatriz Ben Bianca Bo Camille Carlos Carmen Chen Chloe Clara Daan Daniel David Diego Elena Elif Ella
  Emil Emma Erik Eva Fatima Felix Femke Finn Freya Gabriel Grace Hana Hannah Hugo Ida Ingrid Isabel Ivan
  Jack Jan Javier Jonas Julia Kai Karin Kenji Lars Laura Lea Leon Liam Lina Lucas Lucia Luis Maja Marco
  Maria Marta Mateo Max Maya Mehmet Mia Mila Noah Nora Olga Oliver Omar Oscar Paula Pedro Priya Rahul Rosa
  Ruben Sara Sofia Sven Tara Thomas Tim Valentina Victor Wei Yara Yusuf Zara Zoe
`);

export const LAST_NAMES = split(`
  Abbott Adler Alvarez Andersen Bakker Baker Becker Bennett Berg Bianchi Brown Campbell Carter Castro Chen
  Costa Cruz Dahl Davies de_Vries Dubois Eriksson Evans Fischer Fontaine Garcia Gomez Gonzalez Green Gupta
  Hansen Harris Hoffmann Holm Hughes Ibrahim Ito Jansen Jensen Johansson Jones Kaya Keller Khan Kim Klein
  Kowalski Kumar Larsen Laurent Lee Lewis Lindqvist Lopez Martin Martinez Meyer Moreau Morris Muller Nakamura
  Nielsen Novak Nowak OBrien Olsen Ortiz Patel Peeters Perez Petrov Ramos Rao Ricci Rivera Roberts Rossi
  Russo Sanchez Santos Sato Schmidt Schneider Silva Singh Smith Sorensen Suzuki Tanaka Taylor Thomas Torres
  Vargas Visser Wagner Walker Wang Weber White Williams Wilson Wong Yamamoto Yilmaz Young Zhang
`).map((n) => n.replace('_', ' ').replace(/^OBrien$/, "O'Brien"));

export const CITIES = split(`
  Amsterdam Antwerp Athens Auckland Barcelona Berlin Bogota Boston Brisbane Brussels Budapest Cairo Calgary
  Chicago Copenhagen Dublin Edinburgh Florence Frankfurt Geneva Ghent Hamburg Helsinki Istanbul Jakarta
  Krakow Lagos Lima Lisbon Ljubljana London Lyon Madrid Manchester Marseille Melbourne Milan Montreal Mumbai
  Munich Nairobi Oslo Osaka Paris Porto Prague Riga Rotterdam Santiago Seattle Seoul Seville Singapore
  Stockholm Sydney Taipei Tallinn Tokyo Toronto Utrecht Valencia Vancouver Vienna Vilnius Warsaw Zagreb Zurich
`);

export const COUNTRIES = [
  'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'China', 'Colombia', 'Croatia', 'Czechia', 'Denmark',
  'Egypt', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'India', 'Indonesia', 'Ireland', 'Italy', 'Japan', 'Kenya',
  'Latvia', 'Lithuania', 'Mexico', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Peru', 'Poland', 'Portugal', 'Singapore',
  'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Taiwan', 'Turkey', 'United Kingdom', 'United States',
];

export const STREETS = split(`
  Main High Station Church Market Mill Park Garden Bridge River Lake Hill Oak Maple Elm Cedar Willow Birch
  Harbour Castle School Meadow Orchard Forest Spring Sunset Victoria Queen King North South East West
`);
export const STREET_KINDS = ['Street', 'Road', 'Avenue', 'Lane', 'Way', 'Square', 'Drive', 'Boulevard'];

export const COMPANY_WORDS = split(`
  Acme Apex Atlas Beacon Blue Bright Cedar Summit Delta Echo Evergreen Falcon Global Granite Harbor Horizon
  Iron Jade Keystone Lighthouse Lumen Maple Meridian Nimbus North Nova Oak Orbit Pioneer Prime Quantum
  Radiant River Silver Solid Spark Star Sterling Stone Sun Swift Titan Union Vertex Vista Zenith
`);
export const COMPANY_KINDS = ['Systems', 'Solutions', 'Logistics', 'Foods', 'Labs', 'Consulting', 'Industries', 'Media', 'Partners', 'Works', 'Trading', 'Energy'];
export const COMPANY_SUFFIXES = ['Ltd', 'Inc', 'BV', 'GmbH', 'AG', 'SA', 'LLC', 'Group', 'Co'];

export const JOB_TITLES = [
  'Accountant', 'Analyst', 'Architect', 'Assistant', 'Buyer', 'Clerk', 'Consultant', 'Controller', 'Designer', 'Developer', 'Director',
  'Engineer', 'Manager', 'Nurse', 'Officer', 'Planner', 'Product Owner', 'Recruiter', 'Researcher', 'Sales Representative', 'Specialist',
  'Supervisor', 'Support Agent', 'Teacher', 'Technician', 'Tester', 'Trainer', 'Translator', 'Warehouse Operator', 'Writer',
];

export const EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'];

/** Plain English words for words and sentences (no lorem ipsum: the rows should read like data). */
export const WORDS = split(`
  able account action active address advice agent agree air amount annual answer apple area arrive article
  balance basic basket battery beach before begin benefit better bicycle board bottle branch bread brief
  bright budget build button cable calendar camera capital card careful carry case central change channel
  check choice circle clean clear client climate clock cloud coffee collect color comfort common company
  compare complete contact contract copy corner cotton count country course cover create credit culture
  current customer cycle daily data deal deliver demand design detail direct document double draft dream
  early easy edge effect energy engine entry equal estimate event exact example expert extra fabric factor
  fair family fast feature field final finish first flight floor focus forest form fresh friend front full
  future garden general gentle glass global goal golden green group growth guide handle happy harbor health
  heavy history holiday honest house idea image import improve income index inside island issue item
  journey key kitchen label language large layer leader learn letter level light limit line list local
  machine major market master meeting member method middle minute mobile model modern moment money morning
  motion mountain natural network new night normal north note number object ocean offer office open option
  orange order origin outside owner package paper partner party path pattern payment people period person
  picture piece place plan plant pocket point policy simple power present price print private process
  product project proper public purple quality quarter quick quiet radio range rapid rate reason record
  region regular remote report request result review river road round route rule safety sample scale
  schedule school screen season second secure select service session share short signal silver simple
  single small smart solid source space special spring square stable standard station steady stone store
  story street strong study style summer supply support surface system table target team test theory
  ticket timber total touch tower track trade train travel trust update useful valley value version video
  view village visit voice volume water weekly welcome window winter wonder wooden world yellow young zone
`);

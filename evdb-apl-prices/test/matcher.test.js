// Smoke test for the matcher against real fixtures. Run: node test/matcher.test.js
'use strict';
const assert = require('assert');
const path = require('path');
require(path.join(__dirname, '..', 'matcher.js'));
const { APLMatcher } = globalThis;

const evdb = require('./fixtures/evdb-bestellbar.json');
const aplSlugs = require('./fixtures/apl-sitemap.json');

const { mapping, unmatched } = APLMatcher.buildMapping(evdb, aplSlugs);

const matched = Object.keys(mapping).length;
const total = evdb.length;
console.log(`matched: ${matched}/${total} (${((matched / total) * 100).toFixed(1)}%), unmatched: ${unmatched.length}`);

// Spot-check known-good pairs (keys use real fixture model names).
const expect = {
  'Abarth|500e Hatchback': '500e',
  'Abarth|500e Convertible': '500e-cabrio',
  'Abarth|600e Turismo': '600e',
  'Tesla|Model 3 RWD': 'model-3',
  'Tesla|Model Y Premium AWD': 'model-y',
  'Volkswagen|ID.3 Neo 79 kWh': 'id-3',
  'Volkswagen|ID. Buzz NWB Pro': 'id-buzz',
  'Volkswagen|ID.4 Pro': 'id-4',
  'Volkswagen|ID. Polo 155 kW - 52 kWh': 'id-polo',
  'Volkswagen|ID. Cross 155 kW - 52 kWh': 'id-cross',
  'Volkswagen|e-Transporter Kombi L2 210 kW 64 kWh': 'e-transporter-kombi',
  'Volkswagen|e-Caravelle L1 100 kW 64 kWh': 'e-caravelle',
  'Audi|Q4 e-tron': 'q4-e-tron',
  'Audi|Q6 SUV e-tron quattro': 'q6-suv-e-tron',
  'Audi|A6 Avant e-tron performance': 'a6-avant-e-tron',
  'Audi|e-tron GT quattro': 'e-tron-gt',
  'Audi|Q4 Sportback e-tron quattro performance': 'q4-sportback-e-tron',
  'Kia|EV3 Long Range': 'ev3',
  'Kia|EV4 Hatchback 81.4 kWh': 'ev4',
  'Kia|EV4 Fastback 81.4 kWh': 'ev4-fastback',
  'Kia|PV5 Passenger 71.2 kWh': 'pv5-passenger',
  'Hyundai|IONIQ 5 84 kWh RWD': 'ioniq-5',
  'Hyundai|IONIQ 6 Long Range AWD': 'ioniq-6',
  'Hyundai|Kona Electric 65 kWh': 'kona-elektro',
  'Hyundai|INSTER Long Range': 'inster',
  'Renault|5 E-Tech 52kWh 150hp': 'r5-e-tech',
  'Renault|4 E-Tech 40kWh 120hp': 'r4-e-tech',
  'Renault|Megane E-Tech EV60 220hp': 'megane-e-tech',
  'Renault|Scenic E-Tech EV87 220hp': 'scenic-e-tech',
  'Renault|Twingo E-Tech 27.5 kWh': 'twingo',
  'BMW|iX xDrive60': 'ix',
  'BMW|i4 eDrive40': 'i4',
  'BMW|i5 eDrive40 Sedan': 'i5-limousine',
  'BMW|i5 eDrive40 Touring': 'i5-touring',
  'BMW|iX3 50 xDrive': 'ix3',
  'MG|MG4 Urban Comfort Long Range': '4-urban',
  'MG|MG4 Premium Extended Range': '4-urban',
  'Opel|Corsa Electric 50 kWh': 'corsa-electric',
  'Opel|Astra Electric 58 kWh': 'astra-electric',
  'Opel|Astra Sports Tourer Electric 58 kWh': 'astra-sports-tourer-electric',
  'Opel|Mokka Electric GSE': 'mokka-electric',
  'Opel|Grandland Electric 73 kWh': 'grandland',
  'Peugeot|e-208 54 kWh': 'e-208',
  'Peugeot|e-308 SW 58 kWh': 'e-308-sw',
  'Peugeot|e-2008 54 kWh': 'e-2008',
  'Peugeot|e-Rifter M 50 kWh': 'e-rifter',
  'Citroën|ë-C3 Standard Range 44 kWh': 'e-c3',
  'Citroën|ë-C3 Aircross Extended Range 54 kWh': 'e-c3-aircross',
  'Citroën|ë-C4 X 54 kWh': 'e-c4-x',
  'Citroën|ë-Berlingo M 50 kWh': 'e-berlingo',
  'Citroën|ë-SpaceTourer M 75 kWh': 'e-spacetourer',
    'Mercedes-Benz|GLB 350 4MATIC': 'glb',
  'Mercedes-Benz|GLC 400 4MATIC': 'glc-suv',
  'Mercedes-Benz|CLA Shooting Brake 250+': 'cla-shooting-brake',
  'Mercedes-Benz|EQS 450+': 'eqs',
  'Porsche|Cayenne Electric': 'cayenne-electric',
  'Porsche|Macan 4 Electric': 'macan-electric',
  'Porsche|Taycan': 'taycan',
  'Ford|Mustang Mach-E ER RWD': 'mustang-mach-e',
  'Ford|Puma Gen-E': 'puma-gen-e',
  'Ford|e-Tourneo Courier': 'e-tourneo-courier',
  'Ford|e-Tourneo Custom L1 210 kW RWD': 'tourneo-custom',
  'Toyota|bZ4X Touring AWD 74.7 kWh': 'bz4x',
  'Toyota|C-HR+ 77 kWh': 'c-hr',
  'Toyota|Proace Verso L 75 kWh': 'proace-verso',
  'Zeekr|X Long Range RWD': 'x',
  'Zeekr|7GT Long Range RWD': '7gt',
  'Mini|Cooper E': 'cooper-electric',
  'Mini|Aceman SE': 'aceman-electric',
  'Mini|Countryman SE ALL4': 'countryman-electric',
  'BYD|DOLPHIN 60.4 kWh': 'dolphin',
  'BYD|ATTO 3 Evo AWD Excellence': 'atto-3-evo',
  'BYD|SEAL U 87 kWh Design': 'seal-u',
  'Dacia|Spring Electric 100': 'spring',
  'Fiat|500e Hatchback 42 kWh': '500e-3-plus1',
  'Fiat|500e 3+1 42 kWh': '500e-3-plus1',
  'Fiat|600e': '600-elektro',
  'Fiat|Grande Panda': 'grande-panda',
  'Nissan|Ariya 87kWh': 'ariya',
  'Nissan|LEAF Extended Range 75 kWh': 'leaf',
  'Nissan|Micra Extended Range 52 kWh': 'micra',
  'Jeep|Avenger Electric': 'avenger',
  'Jeep|Compass Electric 74 kWh': 'compass',
  'Alpine|A290 Electric 220 hp': 'a290',
  'Leapmotor|T03': 't03',
  'Suzuki|e VITARA 61 kWh 2WD': 'e-vitara',
};
let fail = 0;
for (const [k, want] of Object.entries(expect)) {
  const got = mapping[k];
  if (got !== want) {
    fail++;
    console.log(`  MISMATCH ${k}: got "${got}", want "${want}"`);
  }
}
console.log(fail === 0 ? `PASS: all ${Object.keys(expect).length} spot-checks ok` : `FAIL: ${fail} spot-checks wrong`);

// Unmatched whose make EXISTS on APL are worth reviewing (others can't be matched at all).
const aplMakes = new Set(aplSlugs.map((u) => u.split('/')[2]));
const reviewable = unmatched.filter((u) => aplMakes.has(APLMatcher.aplMakeSlug(u.make)));
console.log(`\nunmatched with APL make present (reviewable): ${reviewable.length}/${unmatched.length}`);
for (const u of reviewable.slice(0, 30)) console.log('   ?', u.make, '|', u.model);

assert.ok(matched / total > 0.6, 'matcher should match >60%');
assert.ok(fail === 0, 'all spot-checks must pass');

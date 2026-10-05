process.env.WMIO_BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
process.env.WMIO_API_KEY  = 'azI6ODJmOTEwMmUtYzMxYy00OTM3LTlhYjctMTFhMjJkZjY0NTFkOm1zaFZGekVqVWxWYjd5YlEydUVtMm9lVXpUVXYwQkpmeUo4WDVrWnNCcUk9';

const { scoreMatch, MATCH_THRESHOLD } = await import('./build/schemaMatcher.js');
const { getActionOutputSchema, getActionInputSchema } = await import('./build/metadataClient.js');
const APP_ID = '2e4b7cb9-1402-4fcc-8243-727f483205ea';

const cardIdField  = { path: 'card_id',  name: 'card_id',  type: 'string', title: 'Card ID',  description: 'Select/specify the ID of the card', required: true, isArrayItem: false, parentKey: '' };
const labelIdField = { path: 'label_id', name: 'label_id', type: 'string', title: 'Label ID', description: 'Select/specify the ID of the label', required: true, isArrayItem: false, parentKey: '' };

// Simulate findResolvingAction for card_id across key actions
const actions = [
  { id: '/v2/search_cards',      label: 'Search Cards' },
  { id: '/v1/get_checklists_on_card', label: 'Get Checklists on Card' },
  { id: '/v1/get_board_labels',  label: 'Get Board Labels' },
  { id: '/v6/update_card',       label: 'Update Card' },
  { id: '/v6/new_card',          label: 'New Card' },
];

const readPrefixes = ["search", "get", "list", "find", "fetch", "lookup", "query"];
function dataSourceBonus(lbl) {
  return readPrefixes.some(p => lbl.toLowerCase().startsWith(p)) ? 1.0 : 0.2;
}

for (const action of actions) {
  const outFields = await getActionOutputSchema(APP_ID, action.id);
  const inFields  = await getActionInputSchema(APP_ID, action.id);
  const reqIn = new Set(inFields.filter(f=>f.required).map(f=>f.path));
  const bonus = dataSourceBonus(action.label);

  console.log(`\n${action.label} (bonus=${bonus}):`);

  // card_id candidates
  const cardCands = outFields
    .filter(f => !reqIn.has(f.path))
    .map(f => ({ f, m: scoreMatch(cardIdField, f) }))
    .filter(({m}) => m.score >= MATCH_THRESHOLD)
    .sort((a,b) => b.m.score - a.m.score)
    .slice(0,3);

  if (cardCands.length) {
    console.log('  card_id candidates:');
    for (const {f, m} of cardCands) {
      console.log(`    adj=${(m.score*bonus).toFixed(3)} raw=${m.score.toFixed(3)} ${f.path} | ${m.reason}`);
    }
  }

  // label_id candidates
  const labelCands = outFields
    .filter(f => !reqIn.has(f.path))
    .map(f => ({ f, m: scoreMatch(labelIdField, f) }))
    .filter(({m}) => m.score >= MATCH_THRESHOLD)
    .sort((a,b) => b.m.score - a.m.score)
    .slice(0,3);

  if (labelCands.length) {
    console.log('  label_id candidates:');
    for (const {f, m} of labelCands) {
      console.log(`    adj=${(m.score*bonus).toFixed(3)} raw=${m.score.toFixed(3)} ${f.path} | ${m.reason}`);
    }
  }
}

// Debug why cards[].id doesn't win for card_id

process.env.WMIO_BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
process.env.WMIO_API_KEY  = 'azI6ODJmOTEwMmUtYzMxYy00OTM3LTlhYjctMTFhMjJkZjY0NTFkOm1zaFZGekVqVWxWYjd5YlEydUVtMm9lVXpUVXYwQkpmeUo4WDVrWnNCcUk9';

const { getActionOutputSchema, getActionInputSchema } = await import('./build/metadataClient.js');
const { scoreMatch, MATCH_THRESHOLD } = await import('./build/schemaMatcher.js');

const APP_ID = '2e4b7cb9-1402-4fcc-8243-727f483205ea';

const cardIdField = { path: 'card_id', name: 'card_id', type: 'string', title: 'Card ID', description: 'Select/specify the ID of the card', required: true, isArrayItem: false, parentKey: '' };
const labelIdField = { path: 'label_id', name: 'label_id', type: 'string', title: 'Label ID', description: 'Select/specify the ID of the label', required: true, isArrayItem: false, parentKey: '' };

// Check search_cards output
const scOut = await getActionOutputSchema(APP_ID, '/v2/search_cards');
const scIn  = await getActionInputSchema(APP_ID,  '/v2/search_cards');

console.log('Search Cards required inputs:', scIn.filter(f=>f.required).map(f=>f.path));
console.log('\nSearch Cards output fields (strings):');
for (const f of scOut.filter(f=>f.type==='string')) {
  const m = scoreMatch(cardIdField, f);
  const isEcho = scIn.some(fi => fi.required && fi.path === f.path);
  console.log(`  ${isEcho?'[ECHO]':'      '} ${m.score.toFixed(3)} ${f.path} | ${m.reason}`);
}

// Check get_board_labels output  
console.log('\n\n=== Get Board Labels output for label_id ===');
const gblOut = await getActionOutputSchema(APP_ID, '/v1/get_board_labels');
const gblIn  = await getActionInputSchema(APP_ID,  '/v1/get_board_labels');
console.log('Get Board Labels required inputs:', gblIn.filter(f=>f.required).map(f=>f.path));
for (const f of gblOut) {
  const m = scoreMatch(labelIdField, f);
  const isEcho = gblIn.some(fi => fi.required && fi.path === f.path);
  console.log(`  ${isEcho?'[ECHO]':'      '} ${m.score.toFixed(3)} ${f.path} | ${m.reason}`);
}

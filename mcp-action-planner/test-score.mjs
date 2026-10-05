// Diagnose scoring for board_id, card_id, label_id resolution

process.env.WMIO_BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
process.env.WMIO_API_KEY  = 'azI6ODJmOTEwMmUtYzMxYy00OTM3LTlhYjctMTFhMjJkZjY0NTFkOm1zaFZGekVqVWxWYjd5YlEydUVtMm9lVXpUVXYwQkpmeUo4WDVrWnNCcUk9';

const { getActionOutputSchema, getActions } = await import('./build/metadataClient.js');
const { scoreMatch } = await import('./build/schemaMatcher.js');

const APP_ID = '2e4b7cb9-1402-4fcc-8243-727f483205ea';

// Fake primary action input fields (board_id, card_id, label_id)
const inputFields = [
  { path: 'board_id', name: 'board_id', type: 'string', title: 'Board ID', description: 'Select/specify the ID of the board', required: true, isArrayItem: false, parentKey: '' },
  { path: 'card_id',  name: 'card_id',  type: 'string', title: 'Card ID',  description: 'Select/specify the ID of the card',  required: true, isArrayItem: false, parentKey: '' },
  { path: 'label_id', name: 'label_id', type: 'string', title: 'Label ID', description: 'Select/specify the ID of the label', required: true, isArrayItem: false, parentKey: '' },
];

// Check these specific actions
const checkActions = [
  { id: '/v2/search_cards',      label: 'Search Cards' },
  { id: '/v4/get_all_boards',    label: 'Get All Boards' },
  { id: '/v1/get_board_labels',  label: 'Get Board Labels' },
  { id: '/v1/remove_label_from_card', label: 'Remove Label from Card' },
  { id: '/v1/add_member_to_card_by_id', label: 'Add Member to Card by ID' },
];

for (const action of checkActions) {
  console.log(`\n=== ${action.label} OUTPUT → scoring against primary inputs ===`);
  let outputFields;
  try {
    outputFields = await getActionOutputSchema(APP_ID, action.id);
  } catch (e) {
    console.log('  ERROR:', e.message);
    continue;
  }

  for (const inField of inputFields) {
    // Score top 3 output fields
    const scored = outputFields
      .filter(f => f.type === 'string' || f.type === 'any')
      .map(f => ({ field: f, ...scoreMatch(inField, f) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    console.log(`  ${inField.name}:`);
    for (const s of scored) {
      console.log(`    ${s.score.toFixed(3)} | ${s.outputField.path} | ${s.reason}`);
    }
  }
}

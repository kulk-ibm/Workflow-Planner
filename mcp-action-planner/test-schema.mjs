// Quick diagnostic: parse the raw schema exactly as the API returns it
// to see what extractFields produces for add_label_to_card

const BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
const API_KEY  = '';
const APP_ID   = '2e4b7cb9-1402-4fcc-8243-727f483205ea';
const ACTION_ID = '/v1/add_label_to_card';

const res = await fetch(
  `${BASE_URL}/apis/v2/rest/applications/${encodeURIComponent(APP_ID)}/actions/${encodeURIComponent(ACTION_ID)}/describe/input`,
  { headers: { 'X-INSTANCE-API-KEY': API_KEY } }
);

const schema = await res.json();

// Inline the extractFields logic from the compiled build to test it in isolation
function extractFields(schema, parentPath = '', parentKey = '', isArrayItem = false, requiredKeys = new Set()) {
  const fields = [];
  const properties = schema['properties'];
  if (!properties) return fields;
  const schemaRequired = schema['required'] ?? [];
  for (const [key, rawProp] of Object.entries(properties)) {
    const prop = rawProp;
    const fullPath = parentPath ? `${parentPath}.${key}` : key;
    const type = prop['type'] ?? 'string';
    const title = prop['title'] ?? prop['displayTitle'] ?? key;
    const description = prop['description'] ?? '';
    const minLength = prop['minLength'];
    const isRequired =
      schemaRequired.includes(key) ||
      requiredKeys.has(key) ||
      (minLength !== undefined && minLength >= 1);

    fields.push({ path: fullPath, name: key, type, title, description, required: isRequired, isArrayItem, parentKey });

    if (type === 'object' && prop['properties']) {
      fields.push(...extractFields(prop, fullPath, key, isArrayItem, new Set(schemaRequired)));
    }
    if (type === 'array' && prop['items']?.type === 'object' && prop['items']?.properties) {
      fields.push(...extractFields(prop['items'], `${fullPath}[]`, key, true, new Set()));
    }
    const oneOf = prop['oneOf'];
    if (oneOf) {
      for (const variant of oneOf) {
        if (variant['properties']) {
          fields.push(...extractFields(variant, fullPath, key, isArrayItem, new Set()));
        }
      }
    }
  }
  return fields;
}

const fields = extractFields(schema);
console.log('\n=== add_label_to_card INPUT fields ===');
for (const f of fields) {
  console.log(`  ${f.required ? '[REQ]' : '[opt]'} ${f.path} (${f.type}) title="${f.title}"`);
}

// Also test search_cards output
const res2 = await fetch(
  `${BASE_URL}/apis/v2/rest/applications/${encodeURIComponent(APP_ID)}/actions/${encodeURIComponent('/v2/search_cards')}/describe/output`,
  { headers: { 'X-INSTANCE-API-KEY': API_KEY } }
);
const schema2 = await res2.json();
const outFields = extractFields(schema2);
console.log('\n=== search_cards OUTPUT fields (first 20) ===');
for (const f of outFields.slice(0, 20)) {
  console.log(`  ${f.path} (${f.type}) isArray=${f.isArrayItem} parent="${f.parentKey}"`);
}

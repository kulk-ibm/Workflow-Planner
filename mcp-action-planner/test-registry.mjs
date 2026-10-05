// Test registry integration

const { resolveConnectorName, listEnabledConnectors } = await import('./build/connectorRegistry.js');

console.log('resolveConnectorName("trello boards"):', JSON.stringify(resolveConnectorName('trello boards')));
console.log('resolveConnectorName("ms teams"):',      JSON.stringify(resolveConnectorName('ms teams')));
console.log('resolveConnectorName("sfdc"):',          JSON.stringify(resolveConnectorName('sfdc')));
console.log('resolveConnectorName("Slack"):',         JSON.stringify(resolveConnectorName('Slack')));
console.log('resolveConnectorName("gemini"):',        JSON.stringify(resolveConnectorName('gemini')));
console.log('resolveConnectorName("unknown-xyz"):',   JSON.stringify(resolveConnectorName('unknown-xyz')));

console.log('\nAll enabled connectors:');
for (const c of listEnabledConnectors()) {
  const idStr = c.id ? c.id.slice(0, 8) + '...' : '(auto)';
  console.log(`  - ${c.name.padEnd(30)} id=${idStr}  aliases=[${(c.aliases||[]).join(', ')}]`);
}

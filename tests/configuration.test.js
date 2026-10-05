const {test}=require('node:test');
const assert=require('node:assert/strict');
const {schema,defaults,project}=require('../configuration/schema');
const {validateSnapshot}=require('../configuration/client');
test('instance configuration is scoped and validates behavior before startup',()=>{
  const config=defaults();const server=defaults(schema.properties.servers.items);server.key='test';server.name='Test';config.servers=[server];
  const snapshot={serviceId:'instance:test',revision:1,config:project(config,'instance','test')};
  validateSnapshot(snapshot,'instance','instance:test');assert.equal(snapshot.config.discord,undefined);
  snapshot.config.instance.backupFrequencyMinutes=0;assert.throws(()=>validateSnapshot(snapshot,'instance','instance:test'),/must be/);
});

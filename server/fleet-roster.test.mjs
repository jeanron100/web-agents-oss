import {test} from 'node:test'
import assert from 'node:assert/strict'
import {maintenanceRoster} from './maintenance-roster.mjs'
test('maintenance uses enabled SSH targets; fresh installs and container-only nodes are excluded',()=>{
 assert.deepEqual(maintenanceRoster({agents:[]}),[])
 assert.deepEqual(maintenanceRoster({agents:[{id:'native',url:'http://localhost:8788',sshTarget:'local'},{id:'remote',url:'http://localhost:8790',sshTarget:'ops@host'},{id:'disabled',url:'http://localhost:8791',sshTarget:'ops@old',enabled:false},{id:'container',url:'http://runner:8788'}]}),['native|local','remote|ops@host'])
})

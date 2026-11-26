'use strict';

// Job name is last so it can contain spaces and pipes.
const queueCommand = "squeue -o '%Q|%i|%P|%u|%t|%M|%D|%R|%j'";
const mineQueueCommand = `${queueCommand} -u tester`;
const runningJobName = 'train_model_blackwell | validation';
const mineQueue = `PRIORITY|JOBID|PARTITION|USER|ST|TIME|NODES|NODELIST(REASON)|NAME\n3427|4201|gpu|tester|R|1:02:03|2|gpu[01-02]|${runningJobName}\n0|4202|gpu|tester|PD|0:00|1|(Resources)|next\n`;
const allQueue = `${mineQueue}98765|4203|batch|another|CG|2-01:02:03|1|cpu09|other\n`;

module.exports = { mineQueue, allQueue, queueCommand, mineQueueCommand, runningJobName };

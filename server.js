const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const ECPair = ECPairFactory.ECPairFactory(ecc);
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = 3000;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/certify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'certify.html'));
});

const certifierPrivateKey = 'KyeEnQiBSfFwN93t1NoPiy4CTa827ygSt4sU3NaaX7r6VUZgPLcT';
const certifierAddress = 'bc1qt60nsqrxwcgewjz7ta8dm5v5zsa4g8m7dly4mp';
const recipientAddress = 'bc1q4v7mmmg9lszec0jlykvmre8xqjk9vavvrhjn66';

app.post('/certify', upload.single('data-file'), async (req, res) => {
    try {
        const filePath = req.file.path;
        let fileHash;

        if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_csv(sheet);
            fileHash = crypto.createHash('sha256').update(data).digest('hex');
        } else {
            const fileBuffer = fs.readFileSync(filePath);
            fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        }

        const txid = await createAndBroadcastTransaction(fileHash);

        fs.unlinkSync(filePath);

        res.json({ txid });
    } catch (error) {
        console.error('Erro durante a certificação:', error);
        res.status(500).json({ error: error.message || 'Erro Interno do Servidor' });
    }
});

async function createAndBroadcastTransaction(fileHash) {
    try {
        const keyPair = ECPair.fromWIF(certifierPrivateKey, bitcoin.networks.bitcoin);

        const utxos = await axios.get(`https://blockstream.info/api/address/${certifierAddress}/utxo`);
        if (utxos.data.length === 0) {
            throw new Error('Nenhum UTXO encontrado para o endereço do certificador.');
        }

        const utxo = utxos.data[0];
        console.log(`UTXO selecionado: ${JSON.stringify(utxo)}`);

        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

        const rawTxResponse = await axios.get(`https://blockstream.info/api/tx/${utxo.txid}/hex`);
        const rawTxHex = rawTxResponse.data;

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: Buffer.from(rawTxHex, 'hex'),
        });

        // Adiciona saída OP_RETURN com o hash do arquivo
        const data = Buffer.from(fileHash, 'hex');
        const embed = bitcoin.payments.embed({ data: [data] });

        console.log("Adicionando OP_RETURN:", embed.output.toString('hex'));

        psbt.addOutput({
            script: embed.output,
            value: 0, // OP_RETURN não contém valor
        });

        const feeRate = await getFeeRate();
        const estimatedTxSize = psbt.extractTransaction().virtualSize() + 50;
        const fee = Math.round(estimatedTxSize * feeRate);

        console.log("Fee estimada:", fee);
        
        if (utxo.value < 1000 + fee) {
            throw new Error('Saldo insuficiente para cobrir a saída e a taxa.');
        }

        const changeValue = utxo.value - 1000 - fee;
        if (changeValue <= 0) {
            throw new Error('Valor de troco inválido ou insuficiente.');
        }

        console.log("Adicionando saída para o destinatário:", recipientAddress, "com valor de 1000 satoshis");
        psbt.addOutput({
            address: recipientAddress,
            value: 1000, // Satoshis para o destinatário
        });

        console.log("Adicionando troco para o endereço do certificador:", certifierAddress, "com valor de", changeValue);
        psbt.addOutput({
            address: certifierAddress,
            value: changeValue, // Troco após subtrair taxa e saída
        });

        // Assina a transação
        psbt.signInput(0, keyPair);
        psbt.finalizeAllInputs();

        // Extrai e transmite a transação
        const tx = psbt.extractTransaction().toHex();
        const response = await axios.post('https://blockstream.info/api/tx', tx);

        return response.data;
    } catch (error) {
        console.error('Erro ao criar ou transmitir a transação:', error);
        throw new Error('Erro ao criar ou transmitir a transação.');
    }
}

async function getFeeRate() {
    const feeRateResponse = await axios.get('https://blockstream.info/api/fee-estimates');
    return feeRateResponse.data['1']; // Taxa para confirmação em 1 bloco
}

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});

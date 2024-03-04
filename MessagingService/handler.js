// MessagingService/handler.js
const AWS = require('aws-sdk');
const awsIot = require('aws-iot-device-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const { MESSAGES_TABLE } = process.env;
const fs = require('fs');
const os = require('os');
const path = require('path');
AWS.config.update({ region: 'eu-west-3' }); // Update this to your region
const secretsManager = new AWS.SecretsManager();

async function getSecretValue(secretName) {
    return new Promise((resolve, reject) => {
        secretsManager.getSecretValue({ SecretId: secretName }, (err, data) => {
            if (err) {
                console.error(err);
                reject(err);
            } else {
                resolve(data.SecretString);
            }
        });
    });
}

// Function to write credentials to temporary files and return paths
async function writeCredentialsToTempFiles(credentials) {
    const tempDir = os.tmpdir();
    const keyPath = path.join(tempDir, 'privateKey.pem');
    const certPath = path.join(tempDir, 'certificate.pem');
    const caPath = path.join(tempDir, 'caCertificate.pem');

    // Corrected to match the actual property names
    if (credentials.privateKey && credentials.certificate && credentials.caCertificate) {
        fs.writeFileSync(keyPath, credentials.privateKey);
        fs.writeFileSync(certPath, credentials.certificate);
        fs.writeFileSync(caPath, credentials.caCertificate);
    } else {
        throw new Error('One or more IoT credential components are undefined.');
    }

    return { keyPath, certPath, caPath };
}

exports.sendMessage = async (event) => {
    // Parse the incoming event
    const { senderId, receiverId, content } = JSON.parse(event.body);
    const timestamp = new Date().getTime();
    const messageId = `${senderId}:${timestamp}`;
    const conversationId = [senderId, receiverId].sort().join(':');

    try {
        const secretName = "IoT_Instant_messaging";
        const secretValue = await getSecretValue(secretName);
        const iotCredentials = JSON.parse(secretValue);

        console.log("IoT Credentials:", iotCredentials);

        const { keyPath, certPath, caPath } = await writeCredentialsToTempFiles(iotCredentials);

        const device = awsIot.device({
            keyPath,
            certPath,
            caPath,
            clientId: `sendMessageLambda-${Math.floor(Math.random() * 100000)}`,
            host: 'a1wqb40c1562d3-ats.iot.eu-west-3.amazonaws.com'
        });

        device.on('connect', () => {
            console.log('Connected to AWS IoT');
            const topic = `messaging/${conversationId}`;
            const messagePayload = JSON.stringify({ messageId, conversationId, senderId, receiverId, timestamp, content });

            device.publish(topic, messagePayload, () => {
                console.log(`Message published to topic ${topic}`);
                device.end();
            });
        });

        const params = {
            TableName: MESSAGES_TABLE,
            Item: { messageId, conversationId, senderId, receiverId, timestamp, content },
        };

        await dynamoDb.put(params).promise();
        return { statusCode: 200, body: JSON.stringify({ message: 'Message sent successfully' }) };
    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send message' }) };
    }
};

exports.getMessages = async (event) => {
    const { conversationId } = event.pathParameters;
    const params = {
        TableName: MESSAGES_TABLE,
        IndexName: 'ConversationIndex',
        KeyConditionExpression: 'conversationId = :conversationId',
        ExpressionAttributeValues: { ':conversationId': conversationId },
    };

    try {
        const data = await dynamoDb.query(params).promise();
        return { statusCode: 200, body: JSON.stringify(data.Items) };
    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not retrieve messages' }) };
    }
};


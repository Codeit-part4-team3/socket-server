const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const wrtc = require("wrtc");
const AWS = require("aws-sdk");
const crypto = require("crypto");

// .DocumentClient를 사용하면 DynamoDB의 데이터를 쉽게 다룰 수 있다. 자동 직렬화 느낌
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    // 다이나모DB의 리전을 설정한다
    region: "us-east-2",
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        // origin은 정확한 클라이언트 주소여야한다.
        origin: "https://pqsoft.net",
        methods: ["GET", "POST", "PUT", "DELETE"],
    },
});

app.get("/", (req, res) => {
    res.send("Hello World!");
});

// dynamoDB의 get, query, scan메서드를 이용해서 데이터를 가져올 수 있는데
// get은 단일 항목을 가져오고
// query는 쿼리 조건에 맞는 항목을 가져오고
// scan은 테이블 전체를 가져온다.
// 따라서 특정 조건을 줘서 데이터를 가져오고 싶을 때는 query를 사용해야한다
app.get("/admin/messages", (req, res) => {
    const params = {
        TableName: "chat-message-table",
        // #channel이라는 표현식이 :channelId와 같은지 확인한다.
        KeyConditionExpression: "#channel = :channelId",
        // channelId가 예약어이기 때문에 ExpressionAttributeNames를 사용해서 예약어를 대체한다.
        ExpressionAttributeNames: {
            "#channel": "channelId",
        },
        // admin 채널의 메시지를 가져오기 위해 channelId를 admin으로 설정한다.
        ExpressionAttributeValues: {
            ":channelId": "admin_chat_channel",
        },
    };
    // query메서드를 사용해서 데이터를 가져온다.
    dynamoDB.query(params, (err, data) => {
        if (err) {
            console.error("Error fetching data from DynamoDB:", err);
            res.status(500).send("Error fetching data from DynamoDB");
        } else {
            console.log("Data fetched successfully from DynamoDB:", data);
            // Set CORS headers
            res.setHeader("Access-Control-Allow-Origin", "*"); // Allow requests from any origin
            res.setHeader(
                "Access-Control-Allow-Methods",
                "GET, POST, PUT, DELETE"
            ); // Allow the specified HTTP methods
            res.status(200).send(data.Items); // Send the fetched messages as response
        }
    });
});

const pc_config = {
    iceServers: [
        {
            urls: ["stun:stun.l.google.com:19302"],
        },
    ],
};

// rooms.roomName.participants = [id: socket.id, id: socket.id, ...]
// rooms.roomName.senderPCs[socket.id] = pc
// rooms.roomName.receiverPCs[socket.id][otherSocket.id] = pc
// receiverPCs의 socket.id는 받는 사람의 socket.id이고 otherSocket.id는 보내는 사람의 socket.id이다.
const rooms = {};
// streams.roomName.socketId = stream
const streams = {};

io.on("connect", (socket) => {
    console.log("connect socket");
    // 음성, 화상 채널 관련 코드
    socket.on("join_voice_channel", (roomName) => {
        console.log("join_room : ", roomName);
        if (!rooms[roomName]) {
            rooms[roomName] = {
                senderPCs: {},
                receiverPCs: {},
                participants: [],
            };
        }

        const pc = new wrtc.RTCPeerConnection(pc_config);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit("ice_candidate_sender", e.candidate);
            }
        };

        pc.ontrack = (e) => {
            if (!streams[roomName]) {
                streams[roomName] = {};
            }
            streams[roomName][socket.id] = e.streams[0];
            console.log(streams);
        };

        if (!rooms[roomName].senderPCs[socket.id]) {
            rooms[roomName].senderPCs[socket.id] = {};
        }
        rooms[roomName].senderPCs[socket.id] = pc;
        rooms[roomName].participants.push({ id: socket.id });
    });

    socket.on("offer", async (offer, roomName) => {
        try {
            const senderPC = rooms[roomName].senderPCs[socket.id];
            await senderPC.setRemoteDescription(
                new wrtc.RTCSessionDescription(offer)
            );
            const answer = await senderPC.createAnswer();
            await senderPC.setLocalDescription(
                new wrtc.RTCSessionDescription(answer)
            );
            socket.emit("answer", answer);

            // Create receiverPCs for other participants in the room
            for (const participant of rooms[roomName].participants) {
                const participantId = participant.id;
                if (participantId === socket.id) continue;

                const receiverPC = new wrtc.RTCPeerConnection(pc_config);
                receiverPC.onicecandidate = (e) => {
                    if (e.candidate) {
                        socket.emit(
                            "ice_candidate_receiver",
                            e.candidate,
                            participantId
                        );
                    }
                };

                // Add tracks to the receiverPC from the corresponding stream
                if (streams[roomName] && streams[roomName][participantId]) {
                    streams[roomName][participantId]
                        .getTracks()
                        .forEach((track) => {
                            receiverPC.addTrack(
                                track,
                                streams[roomName][participantId]
                            );
                        });
                }

                // Create an offer for the receiverPC and emit it to the participant
                const receiverOffer = await receiverPC.createOffer();
                await receiverPC.setLocalDescription(receiverOffer);
                socket.emit(
                    "receiver_offer",
                    receiverOffer,
                    participantId,
                    roomName
                );

                // Store the receiverPC in the data structure
                if (!rooms[roomName].receiverPCs[socket.id]) {
                    rooms[roomName].receiverPCs[socket.id] = {};
                }
                rooms[roomName].receiverPCs[socket.id][participantId] =
                    receiverPC;
            }
        } catch (error) {
            console.error("Error handling offer:", error);
        }
    });

    socket.on("receiver_answer", async (answer, senderId, roomName) => {
        try {
            const receiverPC = rooms[roomName].receiverPCs[socket.id][senderId];
            await receiverPC.setRemoteDescription(
                new wrtc.RTCSessionDescription(answer)
            );
        } catch (error) {
            console.error("Error handling receiver answer:", error);
        }
    });

    socket.on("ice_candidate_sender", async (candidate, senderId, roomName) => {
        console.log("ice_candidate_sender : ", candidate);
        try {
            if (!rooms[roomName]) {
                console.error(`Room ${roomName} does not exist.`);
                return;
            }
            const senderPC = rooms[roomName].senderPCs[senderId];
            await senderPC.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
        } catch (error) {
            console.error("Error handling ice candidate for senderPC:", error);
        }
    });

    socket.on(
        "ice_candidate_receiver",
        async (candidate, receiverId, senderId, roomName) => {
            try {
                if (!rooms[roomName]) {
                    console.error(`Room ${roomName} does not exist.`);
                    return;
                }
                const receiverPC =
                    rooms[roomName].receiverPCs[receiverId][senderId];
                await receiverPC.addIceCandidate(
                    new wrtc.RTCIceCandidate(candidate)
                );
            } catch (error) {
                console.error(
                    "Error handling ice candidate for receiverPC:",
                    error
                );
            }
        }
    );

    // 채팅 채널 관련 코드
    socket.on("join_chat_channel", (roomName) => {
        // DB에서 channel 데이터 가져오기
        // DB에서 채팅 메시지 데이터 가져오기
        // 채팅 메시지 소켓으로 보내기
        socket.join(roomName);
    });

    socket.on("send_message", async (message, roomName) => {
        // 새로운 메시지를 DynamoDB에 업데이트
        const newMessage = {
            messageId: generateMessageId(),
            userId: "1",
            message: message,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "normal",
        };
        console.log(newMessage);

        const updateParams = {
            // 테이블 이름
            TableName: "chat-message-table",
            // channelID을 이용해서 해당 채널의 메시지 리스트에 새로운 메시지를 추가한다.
            Key: {
                channelId: roomName,
            },
            // updateExpression은 SET으로 업데이트할 데이터를 정의한다.
            UpdateExpression:
                // list_append는 DynamoDB에서 제공하는 함수로 리스트에 새로운 요소를 추가한다.
                // if_not_exists는 DynamoDB에서 제공하는 함수로 해당 속성이 존재하지 않으면
                // 두 번째 인자로 전달된 값을 사용한다.
                // :newMessage는 새로운 메시지를 의미한다.
                "SET messages = list_append(if_not_exists(messages, :emptyList), :newMessage)",
            // ExpressionAttributeValues는 UpdateExpression에서 사용한 변수들을 정의한다.
            // :newMessage는 새로운 메시지를 의미한다.
            // :emptyList는 messages 속성이 존재하지 않을 때 사용할 빈 리스트를 의미한다.
            ExpressionAttributeValues: {
                ":newMessage": [newMessage],
                ":emptyList": [],
            },
            // ReturnValues는 업데이트 후 반환할 데이터를 정의한다.
            ReturnValues: "UPDATED_NEW",
        };

        // DynamoDB에 데이터를 업데이트한다.
        dynamoDB.update(updateParams, (err, data) => {
            if (err) {
                console.error("Error updating data in DynamoDB:", err);
            } else {
                console.log("Data updated successfully:", data);
            }
        });

        // 업데이트 이후에 새로운 메시지를 다시 가져와서 해당 채널의 모든 클라이언트에게 전달
        const params = {
            TableName: "chat-message-table",
            KeyConditionExpression: "#channel = :channelId",
            ExpressionAttributeNames: {
                "#channel": "channelId",
            },
            ExpressionAttributeValues: {
                ":channelId": roomName,
            },
        };

        try {
            const queryResult = await dynamoDB.query(params).promise();
            const messages = queryResult.Items;

            // 해당 채널의 모든 클라이언트에게 새로운 메시지 전달
            console.log("newMessageData : ", messages);
            io.to(roomName).emit("receive_message", messages);
        } catch (error) {
            console.error("Error fetching messages from DynamoDB:", error);
        }
    });

    // update Message
    socket.on("update_message", (messageId, roomName) => {
        // update Message
    });

    // delete Message
    socket.on("delete_message", (messageId, roomName) => {
        const deleteParams = {
            TableName: "chat-message-table",
            Key: {
                channelId: roomName,
            },
            // 업데이트 작업을 정의한다.
            // messages 목록 속성에서 ?인덱스 요소를 제거한다
            UpdateExpression: "REMOVE messages[?]",
            // 삭제 작업이 수행되기 위해 필요한 조건을 정의한다.
            // 여기서는 messages 속성이 존재하고 messages 목록에 :messageId가 포함되어 있는지 확인한다.
            ConditionExpression:
                "attribute_exists(messages) AND list_contains(messages, :messageId)",
            // Expression들의 :messageId을 정의한다
            ExpressionAttributeValues: {
                ":messageId": messageId,
            },
        };

        // delete메서드를 안사용한 이유는 delete는 전체 항목(또는 행)를 삭제하려고 할 때 사용하고
        // update메서드는 항목 내부의 속성을 업데이트하거나 제거할 때 사용할 수 있기 떄문
        // 우리는 channelId 내보의 messages 속성에서 특정 메시지를 제거하려고 하기 때문에 update메서드를 사용한다.
        dynamoDB.update(deleteParams, (err, data) => {
            if (err) {
                console.error("Error deleting message from DynamoDB:", err);
            } else {
                console.log(
                    "Message deleted successfully from DynamoDB:",
                    data
                );
            }
        });
    });
});

// Generate a random message ID
function generateMessageId() {
    return crypto.randomBytes(16).toString("hex");
}

server.listen(3000, () => {
    console.log("SERVER IS RUNNING");
});

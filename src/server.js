const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const wrtc = require("wrtc");
const AWS = require("aws-sdk");
const crypto = require("crypto");

// .DocumentClient를 사용하면 DynamoDB의 데이터를 쉽게 다룰 수 있다. 자동 직렬화 느낌
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    // 다이나모DB의 리전을 설정한다(다이나모 DB가 존재하는 지역)
    region: "us-east-2",
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        // origin은 정확한 클라이언트 주소여야한다.
        origin: ["https://pqsoft.net", "http://localhost:5173"],
        methods: ["GET", "POST", "PUT", "DELETE"],
    },
});

app.get("/", (req, res) => {
    res.send("Hello World!");
});

const pc_config = {
    iceServers: [
        {
            urls: ["stun:stun.l.google.com:19302"],
        },
    ],
};

// rooms.roomName.participants = {socketId: socket.id, socketId: socket.id, ...}
// rooms.roomName.receiverPCs[senderPCId] = pc
// rooms.roomName.senderPCs[senderPCId][receiverPCId] = pc
// receiverPCs의 senderPCId는 미디어 스트림을 보내는 socket의 socket.id이고
// receiverPCId는 미디어 스트림을 받는 socket의 socket.id이다.
const rooms = {};
// streams.roomName.socketId = stream
const streams = {};

io.on("connect", (socket) => {
    // 음성 채팅 관련 코드
    socket.on("join_voice_channel", ({ roomName }) => {
        console.log("join_voice_channel : ", roomName);
        socket.join(roomName);
    });

    // ... 기타 코드

    socket.on(
        "newParticipant_offer",
        async ({ offer, senderPCId, roomName }) => {
            // Create RTCPeerConnection
            const pc = new wrtc.RTCPeerConnection(pc_config);

            rooms[roomName] = rooms[roomName] || {};
            rooms[roomName].receiverPCs = rooms[roomName].receiverPCs || {};

            // Check if senderPCId is not undefined
            if (senderPCId) {
                rooms[roomName].receiverPCs[senderPCId] = pc;
            } else {
                console.error("senderPCId is undefined");
                return;
            }

            // media stream을 받는다.
            pc.ontrack = (event) => {
                console.log("ontrack event:", event);
                // event.streams[0]은 media stream을 가지고 있다.
                streams[roomName] = streams[roomName] || {};
                streams[roomName][senderPCId] = event.streams[0];
                console.log("streams:", streams);
            };

            // Set remote description and create answer
            await pc.setRemoteDescription(offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Send answer to the client
            socket.emit("newParticipant_answer", {
                answer,
                senderPCId,
                roomName,
            });
        }
    );

    socket.on(
        "newParticipant_ice_candidate",
        async ({ candidate, newParticipantSocketId, roomName }) => {
            // Check if newParticipantSocketId is not undefined
            if (newParticipantSocketId) {
                const pc = rooms[roomName]?.receiverPCs[newParticipantSocketId];
                if (pc) {
                    await pc.addIceCandidate(
                        new wrtc.RTCIceCandidate(candidate)
                    );
                } else {
                    console.error("RTCPeerConnection not found");
                }
            } else {
                console.error("newParticipantSocketId is undefined");
            }
        }
    );

    // ... 나머지 코드

    // 채팅 채널 관련 코드
    socket.on("join_chat_channel", async (roomName) => {
        console.log("join_chat_channel : ", roomName);
        // DB에서 channel 데이터 가져오기
        // DB에서 채팅 메시지 데이터 가져오기
        // 채팅 메시지 소켓으로 보내기
        socket.join(roomName);
        socket.emit("join_chat_channel_user_join", socket.id);

        // DB에서 해당 채널의 메시지를 가져와서 참가한 소켓에게 보내기
        const queryParams = {
            TableName: "chat-channel-table",
            KeyConditionExpression: "channelId = :channelId",
            ExpressionAttributeValues: {
                ":channelId": roomName, // roomName이 ChannelId가 된다.
            },
        };

        try {
            const data = await dynamoDB.query(queryParams).promise();
            console.log("Messages fetched successfully from DynamoDB:", data);
            // 방금 참가한 소켓에게만 메시지를 보낸다.
            const initialMessages = data.Items;
            io.to(socket.id).emit("initial_chat_messages", initialMessages);
        } catch (error) {
            console.error("Error fetching messages from DynamoDB:", error);
        }
    });

    // interface MessageItem {
    //     channelId: string;
    //     messageId: string;
    //     message: {
    //       userId: string;
    //       message: string;
    //       createdAt: number;
    //       updatedAt: number;
    //       status: string; : 'stable' | 'editing
    //     };
    //   }
    socket.on("send_message", async (message, roomName) => {
        // 새로운 메시지를 DynamoDB에 업데이트
        const messageId = generateMessageId();
        const newMessageItem = {
            channelId: roomName, // Use roomName as the channelId
            messageId: messageId,
            message: {
                createdAt: Date.now(),
                message: message,
                status: "stable",
                updatedAt: Date.now(),
                userId: "1", // Assuming a static userId for now
            },
        };

        console.log("newMessage:", newMessageItem);

        // roomName에 속한 모든 소켓에게 메시지를 보낸다.(보낸 사람 포함)
        io.in(roomName).emit("receive_message", newMessageItem);

        const putParams = {
            TableName: "chat-channel-table", // 테이블 이름
            Item: newMessageItem, // 새로운 메시지
        };

        console.log("Adding a new message to DynamoDB:", putParams);

        try {
            const data = await dynamoDB.put(putParams).promise();
            console.log("Message added successfully to DynamoDB:", data);
        } catch (error) {
            console.error("Error adding message to DynamoDB:", error);
        }
    });

    // update Message
    socket.on("update_message", (messageId, roomName) => {
        // Logic
    });

    // delete Message
    socket.on("delete_message", (messageId, roomName) => {
        // Logic
    });
});

// Generate a random message ID
function generateMessageId() {
    return crypto.randomBytes(16).toString("hex");
}

server.listen(3001, () => {
    console.log("SERVER IS RUNNING");
});

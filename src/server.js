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

server.listen(3000, () => {
    console.log("SERVER IS RUNNING");
});

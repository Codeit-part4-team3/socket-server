const express = require("express");
const http = require("http");
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
            urls: ["turn:54.180.127.213:3478"],
            username: "codeit", // 사용자 이름(username) 설정
            credential: "sprint101!", // 비밀번호(password) 설정
        },
    ],
};

// rooms.roomName.participants = {socketId: socket.id, socketId: socket.id, ...}
// rooms.roomName.receiverPCs[senderPCId] = pc
// rooms.roomName.senderPCs[senderPCId][receiverPCId] = pc
// receiverPCs의 senderPCId는 미디어 스트림을 보내는 socket의 socket.id이고
// receiverPCId는 미디어 스트림을 받는 socket의 socket.id이다.
const rooms = {};
// streams.roomName.senderPCId = stream
const streams = {};

io.on("connect", async (socket) => {
    // 음성 채팅 관련 코드
    socket.on("join_voice_channel", async ({ roomName }) => {
        console.log("join_voice_channel : ", roomName);
        socket.join(roomName);

        // participants에 소켓 아이디를 저장한다.
        rooms[roomName] = rooms[roomName] || {};
        rooms[roomName].participants = rooms[roomName].participants || {};
        rooms[roomName].participants[socket.id] = socket.id;

        for (let senderPCId in streams[roomName]) {
            // 각 미디어 스트림에 대해 새로운 RTCPeerConnection을 생성
            const pc = new wrtc.RTCPeerConnection(pc_config);

            // 새로운 RTCPeerConnection을 rooms 객체에 저장
            rooms[roomName].senderPCs = rooms[roomName].senderPCs || {};
            rooms[roomName].senderPCs[senderPCId] =
                rooms[roomName].senderPCs[senderPCId] || {};
            rooms[roomName].senderPCs[senderPCId][socket.id] = pc;

            // 미디어 스트림을 새로운 RTCPeerConnection에 추가
            streams[roomName][senderPCId].getTracks().forEach((track) => {
                pc.addTrack(track, streams[roomName][senderPCId]);
            });

            // ICE candidate를 수신하면, 이를 다른 클라이언트에게 보냄
            pc.onicecandidate = ({ candidate }) => {
                if (candidate) {
                    socket.emit("existingParticipant_ice_candidate", {
                        candidate,
                        senderPCId,
                    });
                }
            };

            // ice candidate 변경 확인
            pc.oniceconnectionstatechange = (event) => {};

            // SDP offer를 생성하고, 이를 이용하여 로컬 설명을 설정
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                // SDP offer를 새로 참가한 클라이언트에게 보냄
                socket.emit("existingParticipant_offer", {
                    offer: pc.localDescription,
                    senderPCId,
                    roomName,
                });
            } catch (error) {
                console.error(error);
            }
        }
    });

    socket.on(
        "existingParticipant_answer",
        async ({ answer, receiverPCId, senderPCId, roomName }) => {
            // Check if receiverPCId is not undefined
            if (receiverPCId) {
                const pc = rooms[roomName]?.senderPCs[senderPCId][receiverPCId];
                if (pc) {
                    await pc.setRemoteDescription(answer);
                } else {
                    console.error(
                        `RTCPeerConnection not found for receiverPCId: ${receiverPCId}`
                    );
                }
            } else {
                console.error("receiverPCId is undefined");
            }
        }
    );

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
            pc.ontrack = async (event) => {
                // event.streams[0]은 media stream을 가지고 있다.
                streams[roomName] = streams[roomName] || {};
                streams[roomName][senderPCId] = event.streams[0];

                // 참가한 클라이언트의 미디어 스트림을 참여하고 있던 클라이언트들에게 보낸다.
                // 순회하며 피어 연결을 한다
                const newParticipantId = socket.id;

                for (let participant in rooms[roomName].participants) {
                    // 참여한 클라이언트를 제외한 다른 클라이언트에게만 미디어 스트림을 보낸다.
                    if (participant !== newParticipantId) {
                        const pc = new wrtc.RTCPeerConnection(pc_config);
                        rooms[roomName].senderPCs =
                            rooms[roomName].senderPCs || {};
                        rooms[roomName].senderPCs[participant] =
                            rooms[roomName].senderPCs[participant] || {};
                        rooms[roomName].senderPCs[participant][
                            newParticipantId
                        ] = pc;

                        // 미디어 스트림을 새로운 RTCPeerConnection에 추가
                        event.streams[0].getTracks().forEach((track) => {
                            pc.addTrack(track, event.streams[0]);
                        });

                        // ice candidate 핸들러
                        pc.onicecandidate = ({ candidate }) => {
                            if (candidate) {
                                socket
                                    .to(participant)
                                    .emit("newParticipant_ice_candidate", {
                                        candidate,
                                        senderPCId: newParticipantId,
                                    });
                            }
                        };

                        // ice candidate 변경 확인
                        pc.oniceconnectionstatechange = (event) => {};

                        // offer 작업
                        try {
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);

                            // offer를 해당 room에 참여중이던 클라이언트들에게 보냄
                            socket
                                .to(participant)
                                .emit("newParticipant_offer", {
                                    offer: pc.localDescription,
                                    senderPCId: newParticipantId,
                                });
                        } catch (error) {
                            console.error(error);
                        }
                    }
                }
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
        "newParticipant_answer",
        async ({ answer, receiverPCId, senderPCId, roomName }) => {
            // Check if receiverPCId is not undefined
            rooms[roomName] = rooms[roomName] || {};
            rooms[roomName].senderPCs = rooms[roomName].senderPCs || {};
            if (receiverPCId) {
                const pc = rooms[roomName].senderPCs[receiverPCId][senderPCId];
                if (pc) {
                    await pc.setRemoteDescription(answer);
                } else {
                    console.error(
                        `RTCPeerConnection not found for receiverPCId: ${receiverPCId}`
                    );
                }
            } else {
                console.error("receiverPCId is undefined");
            }
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

    // 채팅 채널 관련 코드
    socket.on("join_chat_channel", async (roomName) => {
        console.log("join_chat_channel : ", roomName);
        // DB에서 channel 데이터 가져오기
        // DB에서 채팅 메시지 데이터 가져오기
        // 채팅 메시지 소켓으로 보내기
        socket.join(roomName);
        socket.emit("join_chat_channel_user_join", socket.id);

        // DB에서 해당 채널의 메시지를 가져와서 참가한 소켓에게 보내기
        // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
        const queryParams = {
            TableName: "pq-chat-channel-table",
            KeyConditionExpression: "channelId = :channelId",
            ExpressionAttributeValues: {
                ":channelId": roomName,
            },
            // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
            ScanIndexForward: false,
            // limit의 개수만큼 가져온다
            Limit: 5,
        };

        // DynamoDB에서 기존 채팅 메시지를 가져온다.
        try {
            const data = await dynamoDB.query(queryParams).promise();
            console.log("lastKey:", data.LastEvaluatedKey);
            // 무한 스크롤을 위해 마지막 키를 저장한다.
            console.log("Messages fetched successfully from DynamoDB:", data);
            // 방금 참가한 소켓에게만 메시지를 보낸다.
            const initialMessages = data.Items;
            io.to(socket.id).emit("initial_chat_messages", {
                initialMessages,
                lastKey: data.LastEvaluatedKey,
            });
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
    socket.on("send_message", async ({ message, roomName, userId }) => {
        // 새로운 메시지를 DynamoDB에 업데이트
        const messageId = generateMessageId();
        const newMessageItem = {
            channelId: roomName, // Use roomName as the channelId
            createdAt: Date.now(),
            messageId: messageId,
            message: message,
            userId: userId, // Assuming a static userId for now
            updatedAt: Date.now(),
            status: "stable",
        };

        console.log("newMessage:", newMessageItem);

        // roomName에 속한 모든 소켓에게 메시지를 보낸다.(보낸 사람 포함)
        io.in(roomName).emit("receive_message", newMessageItem);

        const putParams = {
            TableName: "pq-chat-channel-table", // 테이블 이름
            Item: newMessageItem, // 새로운 메시지
        };

        console.log("Adding a new message to DynamoDB:", putParams);

        try {
            const data = await dynamoDB.put(putParams).promise();
            console.log("lastKey:", data.LastEvaluatedKey);
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

    // infinite scroll
    socket.on("more_messages", async ({ roomName, userSocketId, lastKey }) => {
        console.log("more_messages : ", roomName, userSocketId, lastKey);

        // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
        const queryParams = {
            TableName: "pq-chat-channel-table",
            KeyConditionExpression: "channelId = :channelId",
            ExpressionAttributeValues: {
                ":channelId": roomName,
            },
            // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
            ScanIndexForward: false,
            // limit의 개수만큼 가져온다
            Limit: 5,
        };

        if (lastKey) {
            queryParams.ExclusiveStartKey = lastKey;
        }

        try {
            const data = await dynamoDB.query(queryParams).promise();
            // 무한 스크롤을 위해 마지막 키를 저장한다.
            console.log("Messages fetched successfully from DynamoDB:", data);
            const moreMessages = data.Items;
            const isNoMoreMessages = data.LastEvaluatedKey ? false : true;
            io.to(socket.id).emit("more_messages", {
                moreMessages,
                lastKey: data.LastEvaluatedKey,
                isNoMoreMessages,
            });
        } catch (error) {
            console.error("Error fetching messages from DynamoDB:", error);
        }
    });
});

// Generate a random message ID
function generateMessageId() {
    return crypto.randomBytes(16).toString("hex");
}

server.listen(3000, () => {
    console.log("SERVER IS RUNNING");
});

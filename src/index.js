let http = require("http");
let express = require("express");
let cors = require("cors");
let socketio = require("socket.io");
let wrtc = require("wrtc");

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = socketio(server);

// 접속한 user들의 media stream을 받기위한 RTC peer connection을 저장하는 객체
let receiverPCs = {};
// 한 user에게 나머지 media stream을 보내기 위한 RTC peer connection을 저장하는 객체
let senderPCs = {};
// receiverPCs에서 연결된 RTCPeerConnection을 통해 받은 media stream을 user의 socketID와 저장
let users = {};
// user가 어떤 room에 있는지 저장하는 객체
let socketToRoom = {};

// 배열내에 특정 id를 가진 것이 있는지 확인하는 함수
const isInclueded = (arr, id) => {
  let len = arr.length;
  for (let i = 0; i < len; i++) {
    if (arr[i].id === id) {
      return true;
    }
    return false;
  }
};

//
const createReceiverPeerConnection = (socketID, socket, roomID) => {
  // RTC peer connection 생성
  let pc = new wrtc.RTCPeerConnection({
    pc_config,
  });

  // receiverPCs에 저장
  if (receiverPCs[socketID]) receiverPCs[socketID].push(pc);
  else receiverPCs = { ...receiverPCs, [socketID]: pc };

  pc.onicecandidate = (e) => {
    socket.to(socketID).emit("getSenderCandidate", {
      candidate: e.candidate,
    });
  };

  //   pc.oniceconnectionstatechange = (e) => {
  //     console.log(e);
  //   };

  pc.ontrack = (e) => {
    if (users[roomID]) {
      if (!isIncluded(users[roomID], socketID)) {
        users[roomID].push({ id: socketID, stream: e.streams[0] });
      } else return;
    } else {
      users[roomID] = [{ id: socketID, stream: e.streams[0] }];
    }
    socket.broadcast.to(roomID).emit("userJoined", { id: socketID });
  };
};

const createSenderPeerConnection = (receiverSocketID, senderSocketID, socket, roomID) => {
  let pc = new wrtc.RTCPeerConnection({ pc_config });

  if (senderPCs[senderSocketID]) {
    // receiver의 socket.id를 제외한 나머지 것들을 필터링
    senderPCs[senderSocketID].filter((user) => user.id !== receiverSocketID);
    senderPCs[senderSocketID].push({ id: receiverSocketID, pc });
  } else {
    senderPCs = { ...senderPCs, [senderSocketID]: [{ id: receiverSocketID, pc }] };
  }

  pc.onicecandidate = (e) => {
    socket.to(receiverSocketID).emit("getReceiverCandidate", {
      id: senderSocketID,
      candidate: e.candidate,
    });
  };

  // pc.oniceconnectionstatechange = (e) => {
  //     console.log(e);
  // }

  const sendUser = users[roomID].filter((user) => user.id === senderSocketID);
  sendUser[0].stream.getTracks().forEach((track) => pc.addTrack(track, sendUser[0].stream));

  return pc;
};

// 자신을 제외하고 room ID에 포함된 모든 유저의 socket id 배열을 반환
const getOtherUsersInRoom = (socketID, roomID) => {
  let allUsers = [];

  if (!users[roomID]) return allUsers;

  users[roomID].forEach((user) => {
    if (user.id !== socketID) {
      allUsers.push(user.id);
    }
  });

  return allUsers;
};

// user의 정보가 포함된 목록에서 user을 제거한다
const deleteUser = (socketID, roomID) => {
  let roomUsers = users[roomID];
  if (!roomUsers) return;
  roomUsers = roomUsers.filter((user) => user.id !== socketID);
  users[roomID] = roomUsers;
  if (roomUsers.length === 0) {
    delete users[roomID];
  }
  delete socketToRoom[socketID];
};

// 받는 곳과 연결된 peer connection을 닫는다
const closeReceiverPC = (socketID) => {
  if (!receiverPCs[socketID]) return;

  receiverPCs[socketID].close();
  delete receiverPCs[socketID];
};

// 보내는 곳과 연결된 peer connection을 닫는다
const closeSenderPCs = (socketID) => {
  if (!senderPCs[socketID]) return;

  let len = senderPCs[socketID].length;
  for (let i = 0; i < len; i++) {
    senderPCs[socketID][i].pc.close();
    let _senderPCs = senderPCs[senderPCs[socketID][i].id];
    let senderPC = _senderPCs.filter((sPC) => sPC.id === socketID);
    if (senderPC[0]) {
      senderPC[0].pc.close();
      senderPCs[senderPCs[socketID][i].id] = _senderPCs.filter((sPC) => sPC.id !== socketID);
    }
  }

  delete senderPCs[socketID];
};

// socket code
io.on("connection", (socket) => {
  // data = {id, roomID}, id: room에 들어온 user의 socket.id, roomID: room의 id
  socket.on("joinRoom", (data) => {
    try {
      // 지금 들어온 user을 제외한 모든 user들의 socket.id 목록을 가져온다
      let allUsers = getOtherUsersInRoom(data.id, data.roomID);
      // 목록을 보내준다
      io.to(data.id).emit("allUsers", { users: allUsers });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("senderOffer", async (data) => {
    try {
      // socketToRoom의 sender의 socket.id에 data.roomID를 저장한다
      socketToRoom[data.senderSocketID] = data.roomID;
      let pc = createReceiverPeerConnection(data.senderSocketID, socket, data.roomID);
      await pc.setRemoteDescription(data.sdp);
      // answer 생성
      let sdp = await pc.createAnswer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(sdp);
      // sender를 data.roomID에 join 시킨다
      socket.join(data.roomID);
      // sender에게 answer를 보낸다
      io.to(data.senderSocketID).emit(getSenderAnswer, { sdp });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("senderCandidate", async (data) => {
    try {
      // sender의 socket.id에 해당하는 peer connection을 가져온다
      let pc = receiverPCs[data.senderSocketID];
      // candidate을 추가한다
      await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("receiverOffer", async (data) => {
    try {
      let pc = createSenderPeerConnection(data.receiverSocketID, data.senderSocketID, socket, data.roomID);
      await pc.setRemoteDescription(data.sdp);
      let sdp = await pc.createAnswer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(sdp);
      io.to(data.receiverSocketID).emit("getReceiverAnswer", {
        id: data.senderSocketID,
        sdp,
      });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("receiverCandidate", async (data) => {
    // sPC.id === data.receiverSocketID로 필터하는 이유?
    const senderPC = senderPCs[data.senderSocketID].filter((sPC) => sPC.id === data.receiverSocketID);
    await senderPC[0].addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
  });

  socket.on("disconnect", () => {
    try {
      // 유저가 속해있는 roomID를 가져온다
      let roomID = socketToRoom[socket.id];
      deleteUser(socket.id, roomID);
      closeReceiverPC(socket.id);
      closeSenderPC(socket.id);

      socket.broadcast.to(roomID).emit("userLeft", { id: socket.id });
    } catch (error) {
      console.error(error);
    }
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("server running on 8080");
});

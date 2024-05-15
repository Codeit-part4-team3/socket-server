const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AWS = require('aws-sdk');
const crypto = require('crypto');

// .DocumentClient를 사용하면 DynamoDB의 데이터를 쉽게 다룰 수 있다. 자동 직렬화 느낌
const dynamoDB = new AWS.DynamoDB.DocumentClient({
  // 다이나모DB의 리전을 설정한다(다이나모 DB가 존재하는 지역)
  region: 'ap-northeast-2',
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // origin은 정확한 클라이언트 주소여야한다.
    origin: ['https://pqsoft.net', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// P2P 방식
// rooms[roomName] : [{socketId: socket.id, userId: userId, userNickname: userNickname}, {socketId: socket.id, userId: userId, userNickname:userNickname}, ...]
// userId가 아닌 socket.id를 식별자로 사용하자
let rooms = {};
// socketRoom[socket.id] : roomName
let socketRoom = {};
const maximumParticipants = 4;

io.on('connect', async (socket) => {
  // 알림을 위한 socket.join
  socket.on('join', (room) => {
    socket.join(room);
  });

  // 음성, 화상 채널 관련 코드
  socket.on('join_voice_channel', ({ roomName, userId, userNickname }) => {
    // rommName에 해당하는 room 없으면 생성
    if (!rooms[roomName]) {
      rooms[roomName] = [];
    }
    console.log('join_voice_channel : ', roomName);
    // 만약 roomName이 꽉 찼다면, 참가할 수 없다.
    if (rooms[roomName].length === maximumParticipants) {
      socket.emit('room_full');
      return;
    }
    rooms[roomName].push({ socketId: socket.id, userId, userNickname });
    socketRoom[socket.id] = roomName;
    socket.join(roomName);

    // roomName에 있는 방금 참여한 참가자를 제외한 참가자들을 가져와서 보낸다
    const participants = rooms[roomName].filter((participant) => participant.socketId !== socket.id);
    console.log('participants : ', participants);
    socket.emit('participants_list', { participants });
  });

  socket.on('offer', ({ sdp, offerSenderSocketId, offerSenderId, offerSenderNickname, offerReceiverSocketId }) => {
    socket.to(offerReceiverSocketId).emit('get_offer', {
      sdp,
      offerSenderSocketId,
      offerSenderNickname,
      offerSenderId,
    });
  });

  socket.on('answer', ({ sdp, answerSenderSocketId, answerReceiverSocketId }) => {
    socket.to(answerReceiverSocketId).emit('get_answer', {
      sdp,
      answerSenderSocketId,
    });
  });

  socket.on('candidate', ({ candidate, candidateSenderId, candidateReceiverId }) => {
    socket.to(candidateReceiverId).emit('get_candidate', {
      candidate,
      candidateSenderId,
    });
  });

  socket.on('video_track_enabled_changed', ({ enabled, userSocketId, roomName }) => {
    // roomName에 있는 자신을 제외한 모든 소켓에게 enabled가 변경된 소켓의 정보를 보낸다.
    socket.broadcast.to(roomName).emit('video_track_enabled_changed', {
      enabled,
      userSocketId,
    });
  });

  // 회의록 관련 코드
  // 회의록 시작
  socket.on('start_meeting_note', async ({ roomName, meetingNoteName }) => {
    console.log('start_meeting_note : ', roomName, meetingNoteName);
    const meetingNoteId = generateMeetingNoteId();
    // 회의록 DB에 생성
    // {
    //   id: string;
    //   channelId:string;
    //   createdAt:number;
    //   name: string;
    //   content:[
    //   {
    //       userId:number;
    //       text:string
    //   },
    //   ...
    // }
    const newMeetingNote = {
      channelId: roomName,
      id: meetingNoteId,
      createdAt: Date.now(),
      name: meetingNoteName,
      content: [],
    };

    const putParams = {
      TableName: 'pq-meeting-note-table', // 테이블 이름
      Item: newMeetingNote, // 새로운 회의록
    };
    console.log('Adding a new meetingNote to DynamoDB:', putParams);

    try {
      const data = await dynamoDB.put(putParams).promise();
      console.log('meetingNote added successfully to DynamoDB:', data);
      io.in(roomName).emit('start_meeting_note', { meetingNoteId });
    } catch (error) {
      console.error('Error adding meetingNote to DynamoDB:', error);
    }
  });

  // 회의록 내용 업데이트
  socket.on('update_meeting_note', async ({ roomName, meetingNoteId, transcript, userId }) => {
    console.log('update_meeting_note : ', transcript, meetingNoteId, userId);
    // roomName에 있는 모든 소켓에게 업데이트된 회의록 내용을 보낸다.
    socket.to(roomName).emit('update_meeting_note', { transcript, userId });

    // 실시간으로 DB에 저장하는 로직
    const updateParams = {
      TableName: 'pq-meeting-note-table', // 테이블 이름
      Key: {
        id: meetingNoteId,
        channelId: roomName,
      },
      UpdateExpression: 'SET #content = list_append(if_not_exists(#content, :empty_list), :new_content)',
      ExpressionAttributeNames: {
        '#content': 'content',
      },
      ExpressionAttributeValues: {
        ':new_content': [{ userId, text: transcript }],
        ':empty_list': [],
      },
      ReturnValues: 'UPDATED_NEW',
    };

    try {
      const data = await dynamoDB.update(updateParams).promise();
      console.log('meetingNote updated successfully in DynamoDB:', data);
    } catch (error) {
      console.error('Error updating meetingNote in DynamoDB:', error);
    }
  });

  // 회의록 종료
  socket.on('end_meeting_note', ({ roomName }) => {
    io.in(roomName).emit('end_meeting_note');
    // 회의록을 업데이트 한다
    io.in(roomName).emit('get_meeting_note_list');
  });

  socket.on('disconnect', () => {
    if (!socketRoom[socket.id]) return;
    const exitSocketId = socket.id;
    const roomName = socketRoom[exitSocketId];
    // rooms에서 socket.id를 제거한다.
    rooms[roomName] = rooms[roomName].filter((participant) => {
      return participant.socketId !== exitSocketId;
    });
    // socketRoom에서 socket.id를 제거한다.
    delete socketRoom[exitSocketId];
    socket.to(roomName).emit('user_exit', { exitSocketId });
    console.log('disconnect : ', socket.id);
  });

  // 회의록 목록 가져오기
  socket.on('get_meeting_note_list', async ({ roomName }) => {
    // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
    const queryParams = {
      TableName: 'pq-meeting-note-table',
      IndexName: 'channelId-createdAt-index',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
      },
      // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
      ScanIndexForward: false,
    };

    try {
      const data = await dynamoDB.query(queryParams).promise();
      console.log('Meeting notes fetched successfully from DynamoDB:', data);
      const meetingNoteList = data.Items;
      socket.emit('get_meeting_note_list', { meetingNoteList });
    } catch (error) {
      console.error('Error fetching meeting notes from DynamoDB:', error);
    }
  });

  // 채팅 채널 관련 코드
  socket.on('join_chat_channel', async (roomName) => {
    console.log('join_chat_channel : ', roomName);
    // DB에서 channel 데이터 가져오기
    // DB에서 채팅 메시지 데이터 가져오기
    // 채팅 메시지 소켓으로 보내기
    socket.join(roomName);
    socket.emit('join_chat_channel_user_join', socket.id);

    // DB에서 해당 채널의 메시지를 가져와서 참가한 소켓에게 보내기
    // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
    const queryParams = {
      TableName: 'pq-chat-channel-table',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
      },
      // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
      ScanIndexForward: false,
      // limit의 개수만큼 가져온다
      Limit: 40,
    };

    // 가장 마지막 메시지 id를 가져온다.
    const readQueryParams = {
      TableName: 'pq-chat-readmsg-table',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
      },
    };

    // DynamoDB에서 기존 채팅 메시지를 가져온다.
    try {
      const data = await dynamoDB.query(queryParams).promise();
      console.log('lastKey:', data.LastEvaluatedKey);
      // 무한 스크롤을 위해 마지막 키를 저장한다.
      console.log('Messages fetched successfully from DynamoDB:', data);

      // 안 읽은 메시지 계산
      const readMsgData = await dynamoDB.query(readQueryParams).promise();
      data.Items = data.Items.map((item) => {
        let count = 0;
        readMsgData.Items.forEach((readMsg) => {
          if (readMsg.messageId !== item.messageId) ++count;
        });
        readMsgData.Items = readMsgData.Items.filter((readMsg) => readMsg.messageId !== item.messageId);

        return {
          ...item,
          notReadCount: count,
        };
      });

      // 방금 참가한 소켓에게만 메시지를 보낸다.
      const initialMessages = data.Items;
      io.to(socket.id).emit('initial_chat_messages', {
        initialMessages,
        lastKey: data.LastEvaluatedKey,
      });
    } catch (error) {
      console.error('Error fetching messages from DynamoDB:', error);
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
  socket.on('send_message', async ({ message, roomName, userId }) => {
    // 새로운 메시지를 DynamoDB에 업데이트
    const messageId = generateMessageId();

    const getParams = {
      TableName: 'pq-chat-readmsg-table',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
      },
    };
    const channelData = await dynamoDB.query(getParams).promise();
    const userItems = channelData.Items;

    const newMessageItem = {
      channelId: roomName, // Use roomName as the channelId
      createdAt: Date.now(),
      messageId: messageId,
      message: message,
      userId: userId, // Assuming a static userId for now
      updatedAt: Date.now(),
      status: 'stable',
      notReadCount: userItems ? userItems.length : 0,
    };

    console.log('newMessage:', newMessageItem);

    // roomName에 속한 모든 소켓에게 메시지를 보낸다.(보낸 사람 포함)
    io.in(roomName).emit('receive_message', newMessageItem);

    const putParams = {
      TableName: 'pq-chat-channel-table', // 테이블 이름
      Item: newMessageItem, // 새로운 메시지
    };

    console.log('Adding a new message to DynamoDB:', putParams);

    try {
      const data = await dynamoDB.put(putParams).promise();
      console.log('lastKey:', data.LastEvaluatedKey);
      console.log('Message added successfully to DynamoDB:', data);
    } catch (error) {
      console.error('Error adding message to DynamoDB:', error);
    }
  });

  /**
   * 메시지 읽음 처리
   */
  socket.on('read_message', async ({ messageId, roomName, userId }) => {
    // dynamoDB에서 channelId와 userId에 매핑되는 이전 messageId를 가져오기
    const getParams = {
      TableName: 'pq-chat-readmsg-table',
      KeyConditionExpression: 'channelId = :channelId and userId = :userId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
        ':userId': userId,
      },
    };

    try {
      const data = await dynamoDB.query(getParams).promise();
      const prevReadItems = data.Items;
      console.log('[read_message] prevReadItems', prevReadItems);

      // dynamoDB에 새로운 messageId로 업데이트하기
      const readMessageItem = {
        channelId: roomName,
        messageId: messageId,
        userId: userId,
      };

      const putParams = {
        TableName: 'pq-chat-readmsg-table',
        Item: readMessageItem,
      };
      dynamoDB.put(putParams).promise();
      console.log('[read_message] readMessageItem', readMessageItem);

      const prevMessageId = prevReadItems && prevReadItems.length > 0 ? prevReadItems[0].messageId : messageId;
      console.log('[read_message] prevMessgaeId', prevMessageId);
      // roomName에 속한 모든 소켓에게 메시지를 보낸다.(보낸 사람 제외) { 이전messageId, messageId, channelId, userId }
      const response = {
        prevMessageId: prevMessageId,
        messageId: messageId,
        channelId: roomName,
        userId: userId,
      };
      io.in(roomName).emit('read_message', response);
    } catch (error) {
      console.error('Error access readmsg table in DynamoDB:', error);
    }
  });

  /**@ToDo message가 editing인 상태 구현해야함 */
  // // update Message 상태를 editing으로 변경
  // socket.on(
  //     "update_message_editing",
  //     async ({ messageId, createdAt, roomName }) => {
  //         console.log("update_message : ", messageId, createdAt, roomName);
  //     }
  // );

  // update Message 수정 완료
  socket.on('update_message_complete', async ({ messageId, createdAt, message, roomName }) => {
    console.log('update_message : ', messageId, message, roomName);

    // First, use the GSI to get the item
    const getParams = {
      TableName: 'pq-chat-channel-table',
      IndexName: 'messageId-createdAt-index',
      KeyConditionExpression: 'messageId = :messageId and createdAt = :createdAt',
      ExpressionAttributeValues: {
        ':messageId': messageId,
        ':createdAt': createdAt,
      },
    };

    try {
      const data = await dynamoDB.query(getParams).promise();

      console.log(data);

      if (data.Items && data.Items.length > 0) {
        const messageItem = data.Items[0];

        // Then, update the message
        const updateParams = {
          TableName: 'pq-chat-channel-table',
          Key: {
            channelId: messageItem.channelId,
            createdAt: messageItem.createdAt,
          },
          UpdateExpression: 'set #message = :message',
          ExpressionAttributeNames: {
            '#message': 'message',
          },
          ExpressionAttributeValues: {
            ':message': message,
          },
          ReturnValues: 'UPDATED_NEW',
        };

        await dynamoDB.update(updateParams).promise();
      }
      io.in(roomName).emit('update_message_complete', {
        messageId,
        message,
      });
    } catch (error) {
      console.error('Error updating message: ', error);
    }
  });

  // // update Message 취소
  // socket.on("update_message_cancel", async ({ messageId, roomName }) => {
  //     console.log("update_message : ", messageId, roomName);
  // });

  // delete Message
  // gsi를 이용해서 바로 삭제가 불가능하기 때문에
  // messageId와 createdAt로 해당 메시지를 DB에서 가지고 오고 해당 메시지의 정보를 이용해 찾고 삭제해야한다
  socket.on('delete_message', async ({ messageId, createdAt, roomName }) => {
    console.log('delete_message : ', messageId, createdAt, roomName);

    // First, use the GSI to get the item
    const getParams = {
      TableName: 'pq-chat-channel-table',
      IndexName: 'messageId-createdAt-index',
      KeyConditionExpression: 'messageId = :messageId and createdAt = :createdAt',
      ExpressionAttributeValues: {
        ':messageId': messageId,
        ':createdAt': createdAt,
      },
    };

    try {
      const response = await dynamoDB.query(getParams).promise();
      const item = response.Items[0];

      // Then, use the primary key of the item to delete it
      const deleteParams = {
        TableName: 'pq-chat-channel-table',
        Key: {
          channelId: item.channelId,
          createdAt: item.createdAt,
        },
      };

      await dynamoDB.delete(deleteParams).promise();
      console.log('Message deleted successfully from DynamoDB:', messageId);
      io.in(roomName).emit('delete_message', messageId);
    } catch (error) {
      console.error('Error deleting message from DynamoDB:', error);
    }
  });

  // infinite scroll
  socket.on('more_messages', async ({ roomName, userSocketId, lastKey }) => {
    console.log('more_messages : ', roomName, userSocketId, lastKey);

    // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
    const queryParams = {
      TableName: 'pq-chat-channel-table',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': roomName,
      },
      // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
      ScanIndexForward: false,
      // limit의 개수만큼 가져온다
      Limit: 40,
    };

    if (lastKey) {
      queryParams.ExclusiveStartKey = lastKey;
    }

    try {
      const data = await dynamoDB.query(queryParams).promise();
      // 무한 스크롤을 위해 마지막 키를 저장한다.
      console.log('Messages fetched successfully from DynamoDB:', data);
      const moreMessages = data.Items;
      const isNoMoreMessages = data.LastEvaluatedKey ? false : true;
      io.to(socket.id).emit('more_messages', {
        moreMessages,
        lastKey: data.LastEvaluatedKey,
        isNoMoreMessages,
      });
    } catch (error) {
      console.error('Error fetching messages from DynamoDB:', error);
    }
    if (lastKey) {
      queryParams.ExclusiveStartKey = lastKey;
    }

    try {
      const data = await dynamoDB.query(queryParams).promise();
      // 무한 스크롤을 위해 마지막 키를 저장한다.
      console.log('Messages fetched successfully from DynamoDB:', data);
      const moreMessages = data.Items;
      const isNoMoreMessages = data.LastEvaluatedKey ? false : true;
      io.to(socket.id).emit('more_messages', {
        moreMessages,
        lastKey: data.LastEvaluatedKey,
        isNoMoreMessages,
      });
    } catch (error) {
      console.error('Error fetching messages from DynamoDB:', error);
    }
  });

  // Toast 실시간 알림
  socket.on('send_toast', (message) => {
    io.emit('receive_toast', message);
  });

  // 이벤트 실시간 상태 공유
  // 이벤트 종료 후 즉시 사용자의 결제를 막기위함
  socket.on('update_event_status', (status) => {
    io.emit('event_status', status);
  });
});

// Generate a random message ID
function generateMessageId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateMeetingNoteId() {
  return crypto.randomBytes(16).toString('hex');
}

server.listen(3000, () => {
  console.log('SERVER IS RUNNING');
});

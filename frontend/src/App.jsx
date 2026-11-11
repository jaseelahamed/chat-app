import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import AgoraRTC, { AgoraRTCProvider, LocalVideoTrack, RemoteUser, useJoin, useLocalCameraTrack, useLocalMicrophoneTrack, useRemoteUsers } from 'agora-rtc-react';

// ബാക്കെൻഡിലേക്ക് Socket.IO കണക്റ്റ് ചെയ്യുന്നു
const socket = io(' https://chat-app-rvvr.onrender.com');
const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

function App() {
  const [role, setRole] = useState(''); // 'customer' അല്ലെങ്കിൽ 'companion'
  const [isCalling, setIsCalling] = useState(false);
  const [incomingCall, setIncomingCall] = useState(null);
  const [agoraData, setAgoraData] = useState(null); // ടോക്കണും റൂം പേരും സൂക്ഷിക്കാൻ

  useEffect(() => {
    // 1. കോൾ വരുമ്പോൾ കേൾക്കാൻ (കമ്പാനിയന് വേണ്ടി)
    socket.on('incoming_call', (data) => {
      setIncomingCall(data); // സ്ക്രീനിൽ കോൾ വന്നതായി കാണിക്കും
    });

    // 2. ആരെങ്കിലും കോൾ കട്ട് ചെയ്താൽ
    socket.on('force_end_call', () => {
      setAgoraData(null);
      setIsCalling(false);
      setIncomingCall(null);
      alert("കോൾ അവസാനിച്ചു!");
    });

    return () => {
      socket.off('incoming_call');
      socket.off('force_end_call');
    };
  }, []);

  // കസ്റ്റമർ കോൾ ബട്ടൺ അമർത്തുമ്പോൾ
  const startCall = async () => {
    const channelName = "dating_room_" + Math.floor(Math.random() * 1000);
    
    // ബാക്കെൻഡിൽ നിന്ന് Agora ടോക്കൺ വാങ്ങുന്നു
    const response = await axios.get(`http://localhost:5000/api/get-token?channelName=${channelName}`);
    
    // Socket വഴി കമ്പാനിയനെ വിളിക്കുന്നു
    socket.emit('call_user', { channelName: channelName });
    
    setAgoraData({ token: response.data.token, channelName: channelName });
    setIsCalling(true);
  };

  // കമ്പാനിയൻ കോൾ അറ്റൻഡ് ചെയ്യുമ്പോൾ
  const acceptCall = async () => {
    // കസ്റ്റമർ ഉണ്ടാക്കിയ അതേ റൂമിലേക്കുള്ള ടോക്കൺ വാങ്ങുന്നു
    const response = await axios.get(`http://localhost:5000/api/get-token?channelName=${incomingCall.channelName}`);
    
    setAgoraData({ token: response.data.token, channelName: incomingCall.channelName });
    setIncomingCall(null);
    setIsCalling(true);
  };

  // കോൾ കട്ട് ചെയ്യുമ്പോൾ
  const endCall = () => {
    socket.emit('end_call'); // സെർവറിലേക്ക് കട്ട് ചെയ്യാൻ സിഗ്നൽ അയക്കുന്നു
  };

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>MERN + Agora Calling App</h1>

      {/* യൂസർ ആരാണെന്ന് തിരഞ്ഞെടുക്കാൻ */}
      {!role && (
        <div>
          <h2>നിങ്ങൾ ആരാണ്?</h2>
          <button onClick={() => setRole('customer')} style={{ margin: '10px', padding: '10px' }}>കസ്റ്റമർ</button>
          <button onClick={() => setRole('companion')} style={{ margin: '10px', padding: '10px' }}>കമ്പാനിയൻ</button>
        </div>
      )}

      {/* കസ്റ്റമറുടെ സ്ക്രീൻ */}
      {role === 'customer' && !isCalling && (
        <button onClick={startCall} style={{ padding: '15px', background: 'green', color: 'white' }}>
          കമ്പാനിയനെ വിളിക്കുക (Call Now)
        </button>
      )}

      {/* കമ്പാനിയന്റെ സ്ക്രീൻ (കോൾ വരുമ്പോൾ) */}
      {role === 'companion' && incomingCall && !isCalling && (
        <div style={{ border: '2px solid red', padding: '20px' }}>
          <h3>കസ്റ്റമർ വിളിക്കുന്നു...!</h3>
          <button onClick={acceptCall} style={{ padding: '10px', background: 'blue', color: 'white' }}>Accept Call</button>
        </div>
      )}

      {/* Agora വീഡിയോ കോൾ നടക്കുന്ന സ്ഥലം */}
      {agoraData && (
        <AgoraRTCProvider client={client}>
          <VideoCallRoom 
            appId="f7bfb80e620747df978696171343a270" 
            channelName={agoraData.channelName} 
            token={agoraData.token} 
            endCall={endCall} 
          />
        </AgoraRTCProvider>
      )}
    </div>
  );
}

// വീഡിയോ കാണിക്കാനുള്ള പ്രത്യേക കോമ്പോണന്റ്
function VideoCallRoom({ appId, channelName, token, endCall }) {
  // Agora-യിലേക്ക് ജോയിൻ ചെയ്യുന്നു
  useJoin({ appid: appId, channel: channelName, token: token });
  
  // നമ്മുടെ ക്യാമറയും മൈക്കും എടുക്കുന്നു
  const { localMicrophoneTrack } = useLocalMicrophoneTrack();
  const { localCameraTrack } = useLocalCameraTrack();
  
  // കോൾ അറ്റൻഡ് ചെയ്ത മറ്റുള്ളവരെ എടുക്കുന്നു
  const remoteUsers = useRemoteUsers();

  return (
    <div style={{ marginTop: '20px' }}>
      <h2>ലൈവ് വീഡിയോ കോൾ</h2>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px' }}>
        
        {/* നമ്മുടെ സ്വന്തം വീഡിയോ */}
        <div style={{ width: '300px', height: '300px', border: '2px solid black' }}>
          <h4>നിങ്ങൾ</h4>
          <LocalVideoTrack track={localCameraTrack} play={true} style={{ width: '100%', height: '100%' }} />
        </div>

        {/* അപ്പുറത്തുള്ള ആളുടെ വീഡിയോ (കണക്റ്റ് ആകുമ്പോൾ മാത്രം വരും) */}
        {remoteUsers.map((user) => (
          <div key={user.uid} style={{ width: '300px', height: '300px', border: '2px solid black' }}>
            <h4>മറ്റേ വ്യക്തി</h4>
            <RemoteUser user={user} style={{ width: '100%', height: '100%' }} />
          </div>
        ))}
      </div>
      
      <br />
      <button onClick={endCall} style={{ padding: '10px', background: 'red', color: 'white' }}>End Call</button>
    </div>
  );
}

export default App;
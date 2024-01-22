const dasha = require("@dasha.ai/sdk");
const { v4: uuidv4 } = require("uuid");
const express = require("express");
const cors = require("cors");
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();


const expressApp = express();
expressApp.use(express.json());
expressApp.use(cors());

const axios = require("axios").default;

//create a server
const server = http.createServer(expressApp);

const io = new Server(server, {
    cors:{
        origin:'http://localhost:3000',
        methods:['GET', 'POST']
    }
});

let socketId;

io.on("connection", (socket) => {
  console.log("User connected", socket.id);
  console.log("User connected", process.env.APP_ID);
  console.log("User connected", process.env.APP_KEY);
  socketId = socket.id
  //creat a event for room
  // socket.on("join_room", (data) => {
  //     socket.join(data);
  //     console.log(`user with id:${socket.id}:join room:${data}`);
  // });
  // socket.on('send_message', () => {
  // socket.emit('receive_message',data);
  // })
  socket.on("disconnect", () => {
      console.log("User disconnected", socket.id);
  })
})


const main = async () => {
  const app = await dasha.deploy(`${__dirname}/app`);
  let symptoms = [];
  let symptomsId = [];
  let condition = "";
  let cur_diagnosis;
  let cur_choices = [];
  let conclusion = [];
  let conversationId = 0;

  let user_gender = "male";
  let user_age = 30;
  //IO
  let socketId = [];

  // Config to use the Infermedica API
  const config = {
    headers: {
      "App-Id":process.env.APP_ID,
      "App-Key": process.env.APP_KEY,
    },
  };
  //SetExternal is for Dasha AI to integrate with Backend


  //TODO: Send text through websocket to front-end
  app.setExternal("sendText", async (args, conv) => {
    // speaker 0->Dasha 1->User
    console.log(args.ct,args.speaker);
    //io.to(room).emit('event', 'message');.
    io.emit('receive_message',{conversation:args.ct,speaker:args.speaker,id:conversationId})
    conversationId = conversationId + 1
    // io.to('receive_message').emit('',{conversation:args.ct,speaker:args.speaker})
    // send
  });
  
  // Set gender
  app.setExternal("set_gender", async (args, conv) => {
    console.log("Gender is",args.gender,args);
    if(args.gender==='m')
    user_gender="male"
  else if(args.gender==='f')
  user_gender="female"

  });
//Set age
  app.setExternal("set_age", async (args, conv) => {
    console.log("Args is ",args)
    index=args.age.indexOf('.')
    
      user_age=parseInt(args.age)
    
    console.log("Age is ",user_age);
    
  });


  //Add unprocess symptoms to symptoms
  app.setExternal("trackCondition", async (args, conv) => {
    console.log(args.condition);
    symptoms = [...symptoms, args.condition];
    // console.log(symptoms);
  });

  //After adding all, request API format symptoms from Intermedical API
  app.setExternal("parse", async (args, conv) => {
   
    const cons = symptoms.join();
    const data={text:cons,age:{value:user_age}}
    console.log("Symptoms",data)
    try {
      const res = await axios.post(
        "https://api.infermedica.com/v3/parse",
        data,
        config
      );
      await res.data.mentions.map((mention) => {
        symptomsId = [
          ...symptomsId,
          { id: mention.id, choice_id: mention.choice_id, source: "initial" },
        ];
        condition = condition + "," + mention.common_name;
      });
      // console.log(symptomsId);
      // console.log(condition);
      return condition;
    } catch (error) {
     
      console.error("An error occurred:", error.message);
      console.error("Error details:", error);
    }
    
  });

  //Diagnosis will return following questions
  app.setExternal("diagnosis", async (args, conv) => {
    
    const data={ 
      sex: user_gender,
      age: { value: user_age },
      evidence: symptomsId,
     /* extras: { disable_groups: true }, */}

     console.log("Diagnosis data ",data);
    try{
      const res = await axios.post(
        "https://api.infermedica.com/v3/diagnosis",
        data,
        config
      );
      cur_diagnosis = res.data;
      // console.log(cur_diagnosis);
      // console.log(cur_diagnosis.question.items);
  
      //should stop will dtect whether we should come to a conclusion
      return { text: res.data.question.text, should_stop: res.data.should_stop };
    }
    catch (error) {
      console.error("An error occurred:", error.message);
      console.error("Error details:", error);
    }
    
  });

  //Ask user for an answer by index ->
  // Yes ->0
  // No  ->1
  // Don't know ->2
  app.setExternal("answer", async (args, conv) => {
    let i = 0;
    cur_diagnosis.question.items[0].choices.map((choice) => {
      cur_choices = [
        ...cur_choices,
        { id: i, label: choice.label, choice_id: choice.id },
      ];
      i = i + 1;
    });
    return cur_choices;
  });

  // Process answer into new_symptom status
  app.setExternal("answer_diagnosis", async (args, conv) => {
    console.log(args.choice);
    console.log(cur_choices);
    const choice_id = cur_choices[parseInt(args.choice)].choice_id;
    // console.log(choice_id);
    let new_symptom = {
      id: cur_diagnosis.question.items[0].id,
      choice_id: choice_id,
    };
    // console.log(new_symptom);
    symptomsId = [...symptomsId, new_symptom];
    // console.log(symptomsId);

    // empty the cur_choice to reset for next time asking question
    cur_choices = [];
  });

  // Conclusion of the possible disease
  app.setExternal("conclusion", async (args, conv) => {
    cur_diagnosis.conditions.map((condition) => {
      conclusion = [
        ...conclusion,
        {
          condition: condition.common_name,
          probability: condition.probability.toString(),
        },
      ];
    });
    return conclusion;
  });


  //Default code and API for front-end app to connect to Dasha 
  await app.start({ concurrency: 10 });

  expressApp.get("/sip", async (req, res) => {
    const domain = app.account.server.replace("app.", "sip.");
    const endpoint = `wss://${domain}/sip/connect`;

    // client sip address should:
    // 1. start with `sip:reg`
    // 2.  be unique
    // 3. use the domain as the sip server
    const aor = `sip:reg-${uuidv4()}@${domain}`;

    res.send({ aor, endpoint });
  });

  expressApp.post("/call", async (req, res) => {
    const { aor, name } = req.body;
    res.sendStatus(200);

    console.log("Start call for", req.body);
    const conv = app.createConversation({ endpoint: aor, name });
    conv.on("transcription", console.log);
    conv.audio.tts = "dasha";
    conv.audio.noiseVolume = 0;
    const result = await conv.execute();
    // console.log(result.output);
  });
  expressApp.get("/stop", async (req, res) => {
    // const test = await conv.removeAllListeners();
  });
  
 server.listen(8000, () => {
    console.log("Api started on port 8000.");
  });

  process.on("SIGINT", () => server.close());
  server.once("close", async () => {
    await app.stop();
    app.dispose();
  });
};

main();

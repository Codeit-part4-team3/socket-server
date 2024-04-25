#!/bin/bash
cd /home/ubuntu/socket-server 
git pull origin main
sudo npm install
pm2 restart socket-server